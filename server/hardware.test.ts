import { describe, expect, it } from "vitest";
import { bmcHardware, hostHardware, matchBmcs, reboots, type BmcHardware, type HostHardware } from "./hardware.ts";
import { bmcFacts, facts } from "./test-app.ts";

// The iDRAC fixture: system UUID 4c4c4544-..., serial CNIVC0022B0123, service tag 7XQ2R33.
const idrac = bmcHardware(bmcFacts("idrac9"));
const host = (name: string, hardware: Partial<HostHardware> | null) => ({ id: name, name, hardware: hardware && { serial: null, uuid: null, ...hardware } });
const bmc = (server: string | null, hardware: BmcHardware | null = idrac) => ({ id: "b", server, hardware });
const UUID = "4c4c4544-0058-5110-8032-b7c04f523333";

describe("a host and its BMC", () => {
  it("know which machine they are on, without the placeholders boards ship with", () => {
    expect(idrac).toMatchObject({ uuids: [UUID], health: "Critical", unhealthy: 2, powerState: "On" });
    expect(idrac.serials).toEqual(expect.arrayContaining(["CNIVC0022B0123", "7XQ2R33"]));
    const f = facts("debian-sudo");
    expect(hostHardware({ ...f, system: { ...f.system, serial: "To Be Filled By O.E.M.", uuid: "00000000-0000-0000-0000-000000000000" } })).toEqual({
      serial: null,
      uuid: null,
    });
    expect(hostHardware({ ...f, system: { ...f.system, serial: " 7xq2r33 ", uuid: UUID.toUpperCase() } })).toEqual({ serial: "7XQ2R33", uuid: UUID });
  });

  it("confirm the file's server, say when it names the wrong machine, and match one it does not name", () => {
    const hosts = [host("db-1", { serial: "7XQ2R33", uuid: UUID }), host("db-2", { serial: "OTHER", uuid: "11111111-2222-3333-4444-555555555555" })];
    expect(matchBmcs([bmc("db-1")], hosts).get("b")).toEqual({ host: { id: "db-1", name: "db-1" }, state: "confirmed", by: "uuid", detail: null });
    expect(matchBmcs([bmc("db-2")], hosts).get("b")).toEqual({
      host: { id: "db-2", name: "db-2" },
      state: "mismatch",
      by: null,
      detail: `db-2 has UUID 11111111-2222-3333-4444-555555555555; the BMC reports ${UUID}. It matches db-1.`,
    });
    expect(matchBmcs([bmc(null)], hosts).get("b")).toEqual({ host: { id: "db-1", name: "db-1" }, state: "found", by: "uuid", detail: null });
    // By the service tag alone, when the host cannot read its UUID.
    expect(matchBmcs([bmc(null)], [host("db-1", { serial: "7XQ2R33" })]).get("b")).toMatchObject({ state: "found", by: "serial" });
    // A serial that agrees does not outweigh a UUID that differs.
    expect(matchBmcs([bmc("db-1")], [host("db-1", { serial: "7XQ2R33", uuid: "11111111-2222-3333-4444-555555555555" })]).get("b")).toMatchObject({
      state: "mismatch",
    });
  });

  it("wait when there is nothing to compare, and match nothing by guess", () => {
    expect(matchBmcs([bmc("db-1")], [host("db-1", null)]).get("b")).toMatchObject({ state: "unverified" });
    expect(matchBmcs([bmc("db-1")], [host("db-1", {})]).get("b")).toMatchObject({ state: "unverified" });
    expect(matchBmcs([bmc("db-1", null)], [host("db-1", { uuid: UUID })]).get("b")).toMatchObject({ state: "unverified" });
    expect(matchBmcs([bmc(null)], [host("db-1", {})]).has("b")).toBe(false);
    expect(matchBmcs([bmc("gone")], []).has("b")).toBe(false);
  });

  it("put each reboot next to what the BMC logged before it, once per boot", () => {
    const events = bmcFacts("idrac9").events;
    // The exact boot the host reports now, then the same boot and an earlier one as its changes kept them, to five minutes.
    const r = reboots(["2026-10-20T16:12:31.000Z", "2026-10-20T16:10:00.000Z", "2026-09-01T13:20:00.000Z", "nope"], events);
    expect(r.map((x) => x.at)).toEqual(["2026-10-20T16:12:31.000Z", "2026-09-01T13:20:00.000Z"]);
    expect(r[0]!.events.map((e) => e.severity)).toEqual(["Critical"]);
    // "Log cleared." at 13:00 UTC, twenty minutes before.
    expect(r[1]!.events.map((e) => e.message)).toEqual(["Log cleared."]);
  });
});
