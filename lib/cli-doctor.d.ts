import { N as classifyDoubaoFailure, g as DoubaoUpstreamError } from "./doubao-upstream-BALD8tSO.js";
//#region src/cli-doctor.d.ts
type CheckStatus = 'ok' | 'fail' | 'skip';
interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}
interface DoctorReport {
  ok: boolean;
  plugin: string;
  checks: DoctorCheck[];
}
/** Run every check. Never throws: a failed check is data, not a crash. */
declare function runDoctor(): Promise<DoctorReport>;
//#endregion
export { CheckStatus, DoctorCheck, DoctorReport, DoubaoUpstreamError, classifyDoubaoFailure, runDoctor };