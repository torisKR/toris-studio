import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileDeviceItem, PendingApproval } from "./MobileSettingsPermissions";
import { approvalArgs, expiryTime, isPrivateAddress, isQrImageUrl, MobileQrQueue, permissionArgs, projectChoices } from "./MobileSettingsModel";

const projects = [{ name: "낚시 게임" }, { name: "일정 앱" }];
const pending = { id: "attempt-1", name: "내 휴대폰", fingerprint: "SHA256:device", confirmationCode: "123456" };

test("private interface choices exclude public, loopback and invalid addresses", () => {
  for (const value of ["10.0.0.3", "172.16.0.1", "172.31.255.255", "192.168.1.4"]) assert.equal(isPrivateAddress(value), true, value);
  for (const value of ["8.8.8.8", "127.0.0.1", "172.15.0.1", "172.32.0.1", "169.254.1.1", "192.168.999.1", "192.168.01.1", "fd12:3456::1"]) assert.equal(isPrivateAddress(value), false, value);
});

test("approval needs both comparisons and only listed, unambiguous project names", () => {
  assert.equal(approvalArgs(pending, projects, ["낚시 게임"], false, false, true), null);
  assert.equal(approvalArgs(pending, projects, ["낚시 게임"], false, true, false), null);
  assert.equal(approvalArgs(pending, projects, ["임의 프로젝트"], true, true, true), null);
  assert.deepEqual(approvalArgs(pending, projects, ["낚시 게임"], false, true, true), { attemptId: "attempt-1", projects: ["낚시 게임"], allowCreate: false });
  const duplicates = [...projects, { name: "낚시 게임" }];
  assert.deepEqual(projectChoices(duplicates), { names: ["일정 앱"], ambiguous: true });
  assert.equal(permissionArgs(duplicates, ["낚시 게임"], false), null);
});

test("editing permissions requires a fresh explicit create choice", () => {
  assert.equal(permissionArgs(projects, ["일정 앱"], null), null);
  assert.deepEqual(permissionArgs(projects, ["일정 앱"], false), { projects: ["일정 앱"], allowCreate: false });
  assert.deepEqual(permissionArgs(projects, [], true), { projects: [], allowCreate: true });
  assert.equal(permissionArgs(projects, ["일정 앱", "일정 앱"], true), null);
  assert.equal(permissionArgs([], ["일정 앱"], false), null);
});

test("QR accepts local image URLs and valid expiration formats", () => {
  assert.equal(isQrImageUrl("toris-mobile://localhost/qr?v=5e29c18c-c479-468e-8bcc-b2dfe28c9ddf"), true);
  for (const url of ["data:image/png;base64,aGVsbG8=", "blob:local-id", "https://example.com/qr.png", "toris://pair?token=secret", "toris-mobile://localhost/qr?token=secret"]) assert.equal(isQrImageUrl(url), false);
  assert.equal(expiryTime(1_800_000_000), 1_800_000_000_000);
  assert.equal(expiryTime("1800000000000"), 1_800_000_000_000);
  assert.equal(expiryTime("2026-11-06T00:00:00Z"), Date.parse("2026-11-06T00:00:00Z"));
  assert.equal(Number.isNaN(expiryTime("invalid")), true);
  assert.equal(Number.isNaN(expiryTime(null as unknown as string)), true);
});

test("QR issue and close operations stay ordered even across a failure", async () => {
  const queue = new MobileQrQueue();
  const calls: string[] = [];
  let finishIssue!: () => void;
  const waitForIssue = new Promise<void>(resolve => { finishIssue = resolve; });
  const issue = queue.run(async () => { calls.push("issue start"); await waitForIssue; calls.push("issue end"); });
  const close = queue.run(async () => { calls.push("close"); throw new Error("close failed"); });
  const nextIssue = queue.run(async () => { calls.push("next issue"); });
  await Promise.resolve();
  assert.deepEqual(calls, ["issue start"]);
  finishIssue();
  await issue;
  await assert.rejects(close);
  await nextIssue;
  assert.deepEqual(calls, ["issue start", "issue end", "close", "next issue"]);
});

test("pending and device cards expose identity, both comparisons and disabled initial approval", () => {
  const approval = renderToStaticMarkup(<PendingApproval pending={pending} projects={projects} disabled={false} onApprove={async () => true} />);
  assert.match(approval, /내 휴대폰/);
  assert.match(approval, /SHA256:device/);
  assert.match(approval, /123456/);
  assert.match(approval, /휴대폰의 기기 지문이 일치합니다/);
  assert.match(approval, /휴대폰의 확인 코드가 일치합니다/);
  assert.match(approval, /<button[^>]*disabled[^>]*>.*비교 확인 후 기기 승인/);
  const device = renderToStaticMarkup(<MobileDeviceItem device={{ id: "device-1", name: "내 휴대폰", fingerprint: "SHA256:device", lastConnected: null, projects: [{ id: "project-1", name: "낚시 게임" }] }} projects={projects} disabled={false} onPermissions={async () => true} onRevoke={async () => true} />);
  for (const value of ["내 휴대폰", "SHA256:device", "연결 기록 없음", "낚시 게임", "권한 수정", "등록 해제"]) assert.ok(device.includes(value), value);
});

test("turning the host off blocks editing a missing project catalog but still permits revocation", () => {
  const markup = renderToStaticMarkup(<MobileDeviceItem device={{ id: "device-1", name: "내 휴대폰", fingerprint: "SHA256:device", lastConnected: null, projects: [] }} projects={[]} disabled={false} permissionsDisabled onPermissions={async () => true} onRevoke={async () => true} />);
  assert.match(markup, /<button[^>]*disabled[^>]*>권한 수정<\/button>/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>.*등록 해제<\/button>/);
  assert.match(markup, /모바일 연결을 켜고 프로젝트 목록을 확인/);
});
