#!/usr/bin/env node
// Sunsynk Connect MCP server (read-only).
// Talks to the same cloud API the Sunsynk Connect app/web portal uses (api.sunsynk.net).
// Credentials come from environment variables supplied by Claude Desktop (stored in the OS keychain).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";

const BASE_URL = (process.env.SUNSYNK_BASE_URL || "https://api.sunsynk.net").replace(/\/+$/, "");
const USERNAME = process.env.SUNSYNK_USERNAME || "";
const PASSWORD = process.env.SUNSYNK_PASSWORD || "";
const SOURCE = "sunsynk";
const CLIENT_ID = "csp-web";
const TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Sunsynk API client
// ---------------------------------------------------------------------------

let accessToken = null;
let tokenExpiresAt = 0;
let loginInFlight = null;
let cache = { plants: null, inverters: null };

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const nonce = () => Date.now();

async function http(method, path, { body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/${path.replace(/^\/+/, "")}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function fetchPublicKey() {
  const n = nonce();
  const sign = md5(`nonce=${n}&source=${SOURCE}POWER_VIEW`);
  const { status, json } = await http("GET", `anonymous/publicKey?nonce=${n}&source=${SOURCE}&sign=${sign}`, { auth: false });
  if (status !== 200 || !json?.success || !json?.data) {
    throw new Error(`Could not fetch Sunsynk login key (HTTP ${status}${json?.msg ? `: ${json.msg}` : ""}).`);
  }
  return json.data;
}

function rsaEncrypt(rawKey, plaintext) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${rawKey}\n-----END PUBLIC KEY-----`;
  return crypto
    .publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plaintext, "utf8"))
    .toString("base64");
}

async function login() {
  if (!USERNAME || !PASSWORD) {
    throw new Error("Sunsynk username/password are not configured. Open Claude Desktop → Settings → Extensions → Sunsynk and fill them in.");
  }
  const rawKey = await fetchPublicKey();
  const n = nonce();
  const payload = {
    username: USERNAME,
    password: rsaEncrypt(rawKey, PASSWORD),
    grant_type: "password",
    client_id: CLIENT_ID,
    source: SOURCE,
    nonce: n,
    sign: md5(`nonce=${n}&source=${SOURCE}${rawKey.slice(0, 10)}`),
  };
  const { status, json } = await http("POST", "oauth/token/new", { body: payload, auth: false });
  if (status !== 200 || !json?.success || !json?.data?.access_token) {
    throw new Error(`Sunsynk login failed (HTTP ${status}${json?.msg ? `: ${json.msg}` : ""}). Check the username/password in the extension settings.`);
  }
  accessToken = json.data.access_token;
  const ttl = Number(json.data.expires_in) || 3600;
  tokenExpiresAt = Date.now() + (ttl - 60) * 1000;
}

async function ensureLogin(force = false) {
  if (!force && accessToken && Date.now() < tokenExpiresAt) return;
  if (!loginInFlight) loginInFlight = login().finally(() => { loginInFlight = null; });
  await loginInFlight;
}

async function apiGet(path) {
  await ensureLogin();
  let r = await http("GET", path);
  if (r.status === 401 || r.json?.code === 401) {
    await ensureLogin(true);
    r = await http("GET", path);
  }
  if (r.status !== 200) throw new Error(`Sunsynk API returned HTTP ${r.status} for ${path}${r.json?.msg ? `: ${r.json.msg}` : ""}`);
  if (r.json && r.json.success === false) throw new Error(`Sunsynk API error for ${path}: ${r.json.msg || JSON.stringify(r.json).slice(0, 300)}`);
  return r.json?.data ?? r.json;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPlants() {
  if (!cache.plants) {
    const d = await apiGet("api/v1/plants?page=1&limit=20&name=&status=");
    cache.plants = d?.infos ?? [];
  }
  return cache.plants;
}

async function getInverters() {
  if (!cache.inverters) {
    const d = await apiGet("api/v1/inverters?page=1&limit=20&total=0&status=-1&sn=&plantId=&type=-2&softVer=&hmiVer=&agentCompanyId=-1&gsn=");
    cache.inverters = d?.infos ?? [];
  }
  return cache.inverters;
}

async function resolvePlantId(plantId) {
  if (plantId) return plantId;
  const plants = await getPlants();
  if (plants.length === 0) throw new Error("No plants found on this Sunsynk account.");
  return plants[0].id;
}

async function resolveInverterSn(sn) {
  if (sn) return sn;
  const invs = await getInverters();
  if (invs.length === 0) throw new Error("No inverters found on this Sunsynk account.");
  return invs[0].sn;
}

const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ || "Europe/London" });
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function fail(err) {
  return { isError: true, content: [{ type: "text", text: String(err?.message || err) }] };
}
const wrap = (fn) => async (args) => { try { return ok(await fn(args ?? {})); } catch (e) { return fail(e); } };

// ---------------------------------------------------------------------------
// MCP server + tools (all read-only)
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "sunsynk", version: "1.0.0" });
const RO = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  "sunsynk_list_plants",
  {
    title: "List Sunsynk plants",
    description: "List the solar plants (sites) on the Sunsynk Connect account, with id, name, current PV power (pac, W), today's and lifetime generation (kWh) and status.",
    inputSchema: {},
    annotations: RO,
  },
  wrap(async () => {
    cache.plants = null;
    const plants = await getPlants();
    return plants.map((p) => ({
      id: p.id, name: p.name, status: p.status, pv_power_w: num(p.pac),
      generated_today_kwh: num(p.etoday), generated_total_kwh: num(p.etotal),
      updated: p.updateAt, address: p.address,
    }));
  })
);

server.registerTool(
  "sunsynk_list_inverters",
  {
    title: "List Sunsynk inverters",
    description: "List inverters on the account with serial number (sn), model, firmware, status, current power and today's generation. Use the sn with other tools.",
    inputSchema: {},
    annotations: RO,
  },
  wrap(async () => {
    cache.inverters = null;
    const invs = await getInverters();
    return invs.map((i) => ({
      sn: i.sn, alias: i.alias, model: i.model ?? i.equipMode, status: i.status,
      power_w: num(i.pac), generated_today_kwh: num(i.etoday), generated_total_kwh: num(i.etotal),
      plant: i.plant?.name ?? i.plant, firmware: { master: i.masterVer, soft: i.softVer, hmi: i.hmiVer, bms: i.bmsVer },
      gateway_sn: i.gsn, updated: i.updateAt,
    }));
  })
);

server.registerTool(
  "sunsynk_live_status",
  {
    title: "Live inverter status",
    description:
      "Real-time snapshot of the inverter: solar PV input, battery (state of charge, power, temperature), grid (import/export power and today's totals), household load and inverter output. " +
      "Sign conventions follow Sunsynk's API (typically battery power + = discharging, − = charging; grid power + = importing, − = exporting) — check the raw fields if unsure. " +
      "Defaults to the first inverter on the account.",
    inputSchema: {
      sn: z.string().optional().describe("Inverter serial number; omit to use the first inverter"),
      include_raw: z.boolean().optional().describe("Also return the full raw API payloads"),
    },
    annotations: RO,
  },
  wrap(async ({ sn, include_raw }) => {
    sn = await resolveInverterSn(sn);
    const [input, output, grid, load, battery] = await Promise.all([
      apiGet(`api/v1/inverter/${sn}/realtime/input`),
      apiGet(`api/v1/inverter/${sn}/realtime/output`),
      apiGet(`api/v1/inverter/grid/${sn}/realtime?sn=${sn}`),
      apiGet(`api/v1/inverter/load/${sn}/realtime?sn=${sn}`),
      apiGet(`api/v1/inverter/battery/${sn}/realtime?sn=${sn}&lan=en`),
    ]);
    const summary = {
      inverter_sn: sn,
      fetched_at: new Date().toISOString(),
      solar: {
        power_w: num(input?.pac),
        today_kwh: num(input?.etoday),
        total_kwh: num(input?.etotal),
        strings: (input?.pvIV ?? []).map((s) => ({ pv: s.pvNo, voltage_v: num(s.vpv), current_a: num(s.ipv), power_w: num(s.ppv) })),
      },
      battery: {
        soc_pct: num(battery?.soc),
        power_w: num(battery?.power),
        voltage_v: num(battery?.voltage),
        current_a: num(battery?.current),
        temp_c: num(battery?.temp),
        status: battery?.status,
        charged_today_kwh: num(battery?.etodayChg),
        discharged_today_kwh: num(battery?.etodayDischg),
        capacity_ah: num(battery?.capacity ?? battery?.correctCap),
      },
      grid: {
        power_w: num(grid?.pac),
        frequency_hz: num(grid?.fac),
        status: grid?.status,
        imported_today_kwh: num(grid?.etodayFrom),
        exported_today_kwh: num(grid?.etodayTo),
        imported_total_kwh: num(grid?.etotalFrom),
        exported_total_kwh: num(grid?.etotalTo),
      },
      load: {
        power_w: num(load?.totalPower),
        used_today_kwh: num(load?.dailyUsed),
        used_total_kwh: num(load?.totalUsed),
        ups_power_w: num(load?.upsPowerTotal),
      },
      inverter_output: { power_w: num(output?.pac), inverter_power_w: num(output?.pInv), frequency_hz: num(output?.fac) },
    };
    if (include_raw) summary.raw = { input, output, grid, load, battery };
    return summary;
  })
);

server.registerTool(
  "sunsynk_power_flow",
  {
    title: "Plant power flow",
    description: "Current power-flow view for a plant (the 'animated diagram' data in the app): PV, battery, grid, load power and battery SOC, with flow directions.",
    inputSchema: { plant_id: z.number().int().optional().describe("Plant id; omit for the first plant") },
    annotations: RO,
  },
  wrap(async ({ plant_id }) => {
    const id = await resolvePlantId(plant_id);
    return await apiGet(`api/v1/plant/energy/${id}/flow?date=${todayLocal()}`);
  })
);

server.registerTool(
  "sunsynk_energy_history",
  {
    title: "Energy history",
    description:
      "Energy history for a plant. period='day' returns intraday power curves (PV, battery, grid, load, SOC) for the given date (YYYY-MM-DD); " +
      "'month' returns daily kWh totals for a month (YYYY-MM); 'year' returns monthly totals for a year (YYYY); 'total' returns yearly totals.",
    inputSchema: {
      period: z.enum(["day", "month", "year", "total"]).describe("Granularity"),
      date: z.string().optional().describe("YYYY-MM-DD for day, YYYY-MM for month, YYYY for year; defaults to today/current"),
      plant_id: z.number().int().optional().describe("Plant id; omit for the first plant"),
    },
    annotations: RO,
  },
  wrap(async ({ period, date, plant_id }) => {
    const id = await resolvePlantId(plant_id);
    const today = todayLocal();
    const d = date || (period === "day" ? today : period === "month" ? today.slice(0, 7) : period === "year" ? today.slice(0, 4) : today.slice(0, 4));
    return await apiGet(`api/v1/plant/energy/${id}/${period}?lan=en&date=${encodeURIComponent(d)}&id=${id}`);
  })
);

server.registerTool(
  "sunsynk_inverter_settings",
  {
    title: "Read inverter settings",
    description: "Read (not change) the inverter's configuration: work mode, time-of-use slots and SOC targets, grid charge settings, battery limits, export limits etc.",
    inputSchema: { sn: z.string().optional().describe("Inverter serial number; omit for the first inverter") },
    annotations: RO,
  },
  wrap(async ({ sn }) => {
    sn = await resolveInverterSn(sn);
    return await apiGet(`api/v1/common/setting/${sn}/read`);
  })
);

server.registerTool(
  "sunsynk_api_get",
  {
    title: "Raw Sunsynk GET",
    description: "Escape hatch: perform a read-only GET against any Sunsynk Connect endpoint under api/v1/ (e.g. 'api/v1/plant/123/realtime?id=123'). Returns the 'data' field of the response.",
    inputSchema: { path: z.string().describe("Relative path starting with api/v1/") },
    annotations: RO,
  },
  wrap(async ({ path }) => {
    const p = String(path).trim().replace(/^\/+/, "");
    if (!p.startsWith("api/v1/") || /^[a-z]+:\/\//i.test(p) || p.includes("..")) {
      throw new Error("Path must be a relative Sunsynk path starting with api/v1/.");
    }
    return await apiGet(p);
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
