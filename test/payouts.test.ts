import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { approvedCivilDay } from "../src/deadlines.ts";
import { normalizeKey } from "../src/idempotency.ts";
import { seedIncident } from "../src/seed.ts";

type App = ReturnType<typeof createApp>;

function setup(): App {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return createApp(db);
}

async function postJson(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("aprovação da entrega", () => {
  let app: App;

  beforeEach(() => {
    app = setup();
  });

  it("credita a missão aprovada às 22:02 em São Paulo no dia do prazo", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_1842",
      approved_at: "2026-03-13T01:02:00.000Z",
      idempotency_key: "pay_9f3",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ledger: { amount_brl: number } };
    expect(body.ledger.amount_brl).toBe(150);
  });

  it("grava o valor da missão em reais", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_22a",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ledger: { amount_brl: number } };
    expect(body.ledger.amount_brl).toBe(150);
  });

  it("não credita de novo quando a confirmação do provedor chega outra vez", async () => {
    const first = await postJson(app, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_22a",
    });
    expect(first.status).toBe(201);
    const second = await postJson(app, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_22a ",
    });
    expect(second.status).toBeLessThan(500);
    const mission = await app.request("/missions/msn_1900");
    const body = (await mission.json()) as { ledger: unknown[] };
    expect(body.ledger).toHaveLength(1);
  });

  it("aceita a mesma chave uma única vez", async () => {
    const payload = {
      mission_id: "msn_2044",
      approved_at: "2026-03-20T15:00:00.000Z",
      idempotency_key: "pay_same",
    };
    expect((await postJson(app, "/approvals", payload)).status).toBe(201);
    expect((await postJson(app, "/approvals", payload)).status).toBe(200);
    const mission = await app.request("/missions/msn_2044");
    const body = (await mission.json()) as { ledger: unknown[] };
    expect(body.ledger).toHaveLength(1);
  });

  it("recusa aprovação no dia seguinte ao prazo", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_1842",
      approved_at: "2026-03-13T15:00:00.000Z",
      idempotency_key: "pay_late",
    });
    expect(res.status).toBe(409);
  });

  it("responde 404 para missão inexistente", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_missing",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_missing",
    });
    expect(res.status).toBe(404);
  });
});

describe("status do provedor", () => {
  let app: App;

  beforeEach(() => {
    app = setup();
  });

  async function payoutId(): Promise<string> {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-20T15:00:00.000Z",
      idempotency_key: "pay_provider",
    });
    const body = (await res.json()) as { payout: { id: string } };
    return body.payout.id;
  }

  it("mantém o repasse pendente enquanto o provedor não confirma", async () => {
    const id = await payoutId();
    const res = await postJson(app, `/payouts/${id}/provider`, { provider_status: "PENDING" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("marca como pago quando o provedor confirma o recebimento", async () => {
    const id = await payoutId();
    const res = await postJson(app, `/payouts/${id}/provider`, { provider_status: "RECEIVED" });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("paid");
  });

  it("marca falha quando o provedor falha", async () => {
    const id = await payoutId();
    const res = await postJson(app, `/payouts/${id}/provider`, { provider_status: "FAILED" });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("failed");
  });
});

describe("regressões do incidente", () => {
  let app: App;

  beforeEach(() => {
    app = setup();
  });

  it.each([
    { instant: "2026-03-13T02:59:59.999Z", status: 201, credits: 1 },
    { instant: "2026-03-13T03:00:00.000Z", status: 409, credits: 0 },
  ])("respeita o limite do dia de São Paulo em $instant", async ({ instant, status, credits }) => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_1842",
      approved_at: instant,
      idempotency_key: "pay_boundary",
    });
    expect(res.status).toBe(status);
    const mission = await app.request("/missions/msn_1842");
    const body = (await mission.json()) as { ledger: unknown[] };
    expect(body.ledger).toHaveLength(credits);
  });

  it("usa as regras históricas do fuso, sem fixar o deslocamento UTC", () => {
    // São Paulo usava UTC-2 durante o horário de verão nessa data.
    expect(approvedCivilDay("2018-12-01T02:30:00.000Z")).toBe("2018-12-01");
  });

  it.each([
    { variation: "chave idêntica", retryKey: "pay_7c1" },
    { variation: "espaço final", retryKey: "pay_7c1 " },
    { variation: "U+200B final do log", retryKey: "pay_7c1\u200B" },
    { variation: "caixa e bordas mistas", retryKey: "\u200B \tPAY_7C1 \u200B" },
  ])("devolve o mesmo crédito com $variation", async ({ retryKey }) => {
    const payload = {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_7c1",
    };
    const first = await postJson(app, "/approvals", payload);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      ledger: { id: string; mission_id: string; amount_brl: number };
    };
    expect(firstBody.ledger.amount_brl).toBe(80);

    const second = await postJson(app, "/approvals", { ...payload, idempotency_key: retryKey });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ledger: { id: string; mission_id: string } };
    expect(secondBody.ledger.id).toBe(firstBody.ledger.id);
    expect(secondBody.ledger.mission_id).toBe(firstBody.ledger.mission_id);

    const mission = await app.request("/missions/msn_2044");
    const body = (await mission.json()) as { ledger: unknown[] };
    expect(body.ledger).toEqual([firstBody.ledger]);
  });

  it("preserva caracteres internos e outros formatadores Unicode nas chaves", () => {
    expect(normalizeKey("pay _7c1")).toBe("pay _7c1");
    expect(normalizeKey("pay_\u200B7c1")).toBe("pay_\u200B7c1");
    expect(normalizeKey("pay_7c1\u200D")).toBe("pay_7c1\u200D");
  });

  it("preserva o escopo global da chave idempotente", async () => {
    const payload = {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_global",
    };
    const first = await postJson(app, "/approvals", payload);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { ledger: unknown };
    const second = await postJson(app, "/approvals", {
      ...payload,
      mission_id: "msn_2044",
      idempotency_key: "PAY_GLOBAL ",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ledger: unknown };
    expect(secondBody.ledger).toEqual(firstBody.ledger);
    const mission = await app.request("/missions/msn_2044");
    const body = (await mission.json()) as { ledger: unknown[] };
    expect(body.ledger).toHaveLength(0);
  });

  it.each([
    { providerStatus: "PENDING", status: "pending" },
    { providerStatus: "RECEIVED", status: "paid" },
    { providerStatus: "CONFIRMED", status: "paid" },
    { providerStatus: "FAILED", status: "failed" },
  ])("persiste $providerStatus como $status", async ({ providerStatus, status }) => {
    const approval = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-20T15:00:00.000Z",
      idempotency_key: "pay_status",
    });
    expect(approval.status).toBe(201);
    const { payout } = (await approval.json()) as { payout: { id: string } };
    const callback = await postJson(app, `/payouts/${payout.id}/provider`, {
      provider_status: providerStatus,
    });
    expect(callback.status).toBe(200);
    const mission = await app.request("/missions/msn_2044");
    const body = (await mission.json()) as { payout: { provider_status: string; status: string } };
    expect(body.payout.provider_status).toBe(providerStatus);
    expect(body.payout.status).toBe(status);
  });

  it("recusa status desconhecido sem alterar o repasse", async () => {
    const approval = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-20T15:00:00.000Z",
      idempotency_key: "pay_unknown",
    });
    expect(approval.status).toBe(201);
    const { payout } = (await approval.json()) as { payout: { id: string } };
    const callback = await postJson(app, `/payouts/${payout.id}/provider`, { provider_status: "UNKNOWN" });
    expect(callback.status).toBe(400);
    const mission = await app.request("/missions/msn_2044");
    const body = (await mission.json()) as { payout: unknown };
    expect(body.payout).toEqual(payout);
  });
});
