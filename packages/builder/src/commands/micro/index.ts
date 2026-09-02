/**
 * blue micro — local microtask tracker
 *
 * Subcommands:
 *   blue micro post     — create a microtask
 *   blue micro list     — browse open microtasks
 *   blue micro accept   — claim a slot
 *   blue micro submit   — submit proof
 *   blue micro approve  — approve/reject a submission
 *   blue micro profile  — doer performance + approved value
 *
 * State lives in ~/.blue-agent/. No payment rail is attached.
 */

export { runMicroPost } from "./post";
export { runMicroList } from "./list";
export { runMicroAccept } from "./accept";
export { runMicroSubmit } from "./submit";
export { runMicroApprove } from "./approve";
export { runMicroProfile } from "./profile";
