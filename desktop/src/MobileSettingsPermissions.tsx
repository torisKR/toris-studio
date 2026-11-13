import { useId, useState } from "react";
import { Check, Smartphone, Trash2 } from "lucide-react";
import { approvalArgs, permissionArgs, projectChoices } from "./MobileSettingsModel";
import type { MobileDevice, MobilePending, MobileProject } from "./MobileSettingsModel";

type Permissions = { projects: string[]; allowCreate: boolean };

function ProjectFields({ projects, selected, onChange, disabled }: {
  projects: MobileProject[]; selected: string[]; onChange: (names: string[]) => void; disabled: boolean;
}) {
  const { names, ambiguous } = projectChoices(projects);
  return <fieldset className="mobile-settings-fields" disabled={disabled}>
    <legend>허용할 기존 프로젝트</legend>
    {names.length ? <div className="mobile-settings-projects">{names.map(name =>
      <label key={name}><input type="checkbox" checked={selected.includes(name)} onChange={event => onChange(event.target.checked ? [...selected, name] : selected.filter(value => value !== name))} /><span>{name}</span></label>
    )}</div> : <p className="social-form-hint">선택할 수 있는 기존 프로젝트가 없습니다.</p>}
    {ambiguous && <p className="social-form-hint">같은 이름의 프로젝트는 구분할 수 없어 선택 목록에서 제외했습니다.</p>}
    {selected.some(name => !names.includes(name)) && <p className="social-form-error">프로젝트 목록이 바뀌었습니다. 취소하고 다시 선택하세요.</p>}
  </fieldset>;
}

export function PendingApproval({ pending, projects, disabled, onApprove }: {
  pending: MobilePending; projects: MobileProject[]; disabled: boolean;
  onApprove: (args: { attemptId: string } & Permissions) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [allowCreate, setAllowCreate] = useState(false);
  const [fingerprintMatches, setFingerprintMatches] = useState(false);
  const [codeMatches, setCodeMatches] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const args = approvalArgs(pending, projects, selected, allowCreate, fingerprintMatches, codeMatches);

  async function approve() {
    if (!args || disabled || submitted) return;
    if (await onApprove(args)) setSubmitted(true);
  }

  return <section className="mobile-settings-pending" aria-labelledby="mobile-pending-title">
    <h3 id="mobile-pending-title">등록 요청 확인</h3>
    <p>휴대폰에 표시된 기기 지문과 확인 코드를 아래 값과 직접 비교하세요. 일치하지 않으면 승인하지 말고 등록 화면을 닫으세요.</p>
    <dl className="mobile-settings-details">
      <div><dt>기기 이름</dt><dd>{pending.name}</dd></div>
      <div><dt>기기 지문</dt><dd><code>{pending.fingerprint}</code></dd></div>
      <div><dt>확인 코드</dt><dd><strong className="mobile-settings-code">{pending.confirmationCode}</strong></dd></div>
    </dl>
    <div className="mobile-settings-confirmations">
      <label><input type="checkbox" checked={fingerprintMatches} disabled={disabled || submitted} onChange={event => setFingerprintMatches(event.target.checked)} /><span>휴대폰의 기기 지문이 일치합니다.</span></label>
      <label><input type="checkbox" checked={codeMatches} disabled={disabled || submitted} onChange={event => setCodeMatches(event.target.checked)} /><span>휴대폰의 확인 코드가 일치합니다.</span></label>
    </div>
    <ProjectFields projects={projects} selected={selected} onChange={setSelected} disabled={disabled || submitted} />
    <label className="mobile-settings-check"><input type="checkbox" checked={allowCreate} disabled={disabled || submitted} onChange={event => setAllowCreate(event.target.checked)} /><span>새 프로젝트 생성도 허용</span></label>
    <p className="social-form-hint">선택한 프로젝트와 새 프로젝트 생성 권한만 이 기기에 부여합니다.</p>
    {submitted ? <p role="status">승인했습니다. 휴대폰에서 연결을 완료하세요.</p> :
      <button type="button" className="social-button primary" disabled={disabled || !args} onClick={() => void approve()}><Check size={15} aria-hidden="true" />비교 확인 후 기기 승인</button>}
  </section>;
}

function PermissionEditor({ device, projects, disabled, unavailable, onCancel, onSave }: {
  device: MobileDevice; projects: MobileProject[]; disabled: boolean; unavailable: boolean; onCancel: () => void;
  onSave: (permissions: Permissions) => Promise<boolean>;
}) {
  const groupId = useId();
  const choices = projectChoices(projects).names;
  const [selected, setSelected] = useState(() => choices.filter(name => device.projects.some(project => project.name === name)));
  const [allowCreate, setAllowCreate] = useState<boolean | null>(null);
  const [unlistedAcknowledged, setUnlistedAcknowledged] = useState(false);
  const [initialGrants] = useState(() => JSON.stringify(device.projects.map(project => [project.id, project.name]).sort()));
  const grantsChanged = initialGrants !== JSON.stringify(device.projects.map(project => [project.id, project.name]).sort());
  const unlisted = device.projects.some(project => !choices.includes(project.name));
  const args = permissionArgs(projects, selected, allowCreate);
  const locked = disabled || unavailable;

  async function save() {
    if (!args || locked || grantsChanged || (unlisted && !unlistedAcknowledged)) return;
    if (await onSave(args)) onCancel();
  }

  return <div className="mobile-settings-editor">
    <ProjectFields projects={projects} selected={selected} onChange={setSelected} disabled={locked} />
    {unlisted && <label className="mobile-settings-check"><input type="checkbox" checked={unlistedAcknowledged} disabled={locked} onChange={event => setUnlistedAcknowledged(event.target.checked)} /><span>목록에 없는 기존 권한 항목을 확인했으며 선택된 권한만 저장합니다.</span></label>}
    <fieldset className="mobile-settings-fields" disabled={locked}>
      <legend>새 프로젝트 생성 권한</legend>
      <p className="social-form-hint">현재 설정은 별도로 제공되지 않습니다. 저장하려면 허용 여부를 다시 선택하세요.</p>
      <div className="mobile-settings-options">
        <label><input type="radio" name={groupId} checked={allowCreate === false} onChange={() => setAllowCreate(false)} /><span>허용 안 함</span></label>
        <label><input type="radio" name={groupId} checked={allowCreate === true} onChange={() => setAllowCreate(true)} /><span>허용</span></label>
      </div>
    </fieldset>
    {grantsChanged && <p className="social-form-error" role="alert">기기 권한이 변경되었습니다. 취소하고 다시 편집하세요.</p>}
    <div className="mobile-settings-actions"><button type="button" className="social-button compact" disabled={disabled} onClick={onCancel}>취소</button><button type="button" className="social-button compact primary" disabled={locked || !args || grantsChanged || (unlisted && !unlistedAcknowledged)} onClick={() => void save()}>권한 저장</button></div>
  </div>;
}

function formatLastConnected(value: string | null) {
  if (!value) return "연결 기록 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "연결 시각 확인 불가" : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function MobileDeviceItem({ device, projects, disabled, permissionsDisabled = false, onPermissions, onRevoke }: {
  device: MobileDevice; projects: MobileProject[]; disabled: boolean; permissionsDisabled?: boolean;
  onPermissions: (deviceId: string, permissions: Permissions) => Promise<boolean>;
  onRevoke: (deviceId: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  return <article className="mobile-settings-device">
    <h4><Smartphone size={16} aria-hidden="true" />{device.name}</h4>
    <dl className="mobile-settings-details">
      <div><dt>기기 지문</dt><dd><code>{device.fingerprint}</code></dd></div>
      <div><dt>마지막 연결</dt><dd>{formatLastConnected(device.lastConnected)}</dd></div>
      <div><dt>허용된 항목</dt><dd>{device.projects.length ? device.projects.map(project => project.name).join(", ") : "없음"}</dd></div>
    </dl>
    {editing ? <PermissionEditor device={device} projects={projects} disabled={disabled} unavailable={permissionsDisabled} onCancel={() => setEditing(false)} onSave={permissions => onPermissions(device.id, permissions)} /> :
      <div className="mobile-settings-actions"><button type="button" className="social-button compact" disabled={disabled || permissionsDisabled || confirmRevoke} onClick={() => setEditing(true)}>권한 수정</button><button type="button" className="social-button compact" disabled={disabled || confirmRevoke} onClick={() => setConfirmRevoke(true)}><Trash2 size={14} aria-hidden="true" />등록 해제</button></div>}
    {permissionsDisabled && <p className="social-form-hint">권한을 수정하려면 모바일 연결을 켜고 프로젝트 목록을 확인하세요.</p>}
    {confirmRevoke && <div className="mobile-settings-revoke" role="group" aria-label={`${device.name} 등록 해제 확인`}>
      <p>등록을 해제하면 이 기기의 연결이 종료되며 다시 등록해야 합니다.</p>
      <div className="mobile-settings-actions"><button type="button" className="social-button compact" disabled={disabled} onClick={() => setConfirmRevoke(false)}>취소</button><button type="button" className="social-button compact" disabled={disabled} onClick={() => void onRevoke(device.id)}>등록 해제 확인</button></div>
    </div>}
  </article>;
}
