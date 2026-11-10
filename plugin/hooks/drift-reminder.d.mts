export type DriftGroup = { means: string; layer: string; files: string[] };
export type HookDrift = {
  status: "no-baseline" | "no-watch" | "ok" | "uncovered" | "error";
  base?: string;
  groups: DriftGroup[];
  message: string;
};
export const groupKey: (group: DriftGroup) => string;
export const decide: (
  input: { session_id: string; stop_hook_active?: boolean },
  drift: HookDrift | null,
  seen: string[],
) => { output: { decision: "block"; reason: string } | null; seen: string[] };
export const findMapDir: (cwd: string) => string | null;
