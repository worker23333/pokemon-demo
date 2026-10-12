import type { Battle, BattleCommand } from "./api";

type Command = { command: BattleCommand; moveId?: number; label: string };
type Event = Battle["events"][number];
export type CommandAttempt = Command & {
  battleId: string;
  actor: string;
  delivery: "sending" | "accepted" | "failed" | "uncertain";
  expiresTick?: number;
  message?: string;
  /** The snapshot boundary before sending, not a server request identifier. */
  baselineTick: number;
  baselineSeq: number;
  baselineEvents: string[];
  baselineActiveExpiry?: number;
};
export type CommandFeedback = { phase: string; title: string; detail: string; key?: string };

const labels: Record<BattleCommand, string> = {
  attack: "进攻", dodge: "躲避", defend: "防守", retreat: "拉开距离",
  move: "招式", weaken: "控血", hold: "停手保命",
};
const isCommand = (value: unknown): value is BattleCommand => typeof value === "string" && Object.hasOwn(labels, value);
const same = (a: { command?: unknown; moveId?: unknown } | Event, b: { command?: unknown; moveId?: unknown } | Event) =>
  a.command === b.command && (a.command !== "move" || a.moveId === b.moveId);
const keyOf = (command: { command: BattleCommand; moveId?: number }) =>
  command.command === "move" ? `move:${command.moveId}` : command.command;
const eventKey = (event: Event) => Number.isFinite(event.eventSeq) ? `seq:${event.eventSeq}` :
  JSON.stringify([event.tick, event.effectiveTick, event.kind, event.actor, event.command, event.moveId, event.expiresTick, event.reason]);
const ordered = (events: Event[]) => events.map((event, index) => ({ event, index })).sort((a, b) =>
  Number.isFinite(a.event.eventSeq) && Number.isFinite(b.event.eventSeq)
    ? a.event.eventSeq - b.event.eventSeq
    : a.event.tick - b.event.tick || a.index - b.index).map(({ event }) => event);
const sequence = (b: Battle) => Math.max(0, (b as Battle & { eventSeq?: number }).eventSeq ?? 0,
  ...b.events.map(event => Number.isFinite(event.eventSeq) ? event.eventSeq : 0));

export function beginCommand(b: Battle, actor: string, option: Command): CommandAttempt {
  return {
    battleId: b.id, actor, command: option.command, moveId: option.moveId, label: option.label,
    delivery: "sending", baselineTick: b.tick, baselineSeq: sequence(b),
    baselineEvents: b.events.map(eventKey),
    baselineActiveExpiry: b.fighters.find(fighter => fighter.id === actor)?.activeCommand?.expiresTick,
  };
}

/** Derive feedback only from this command's receipt interval. HTTP acceptance is not execution. */
export function commandFeedback(b: Battle, actor: string | undefined, attempt?: CommandAttempt): CommandFeedback {
  const fighter = b.fighters.find(candidate => candidate.id === actor);
  if (!fighter) return { phase: "unavailable", title: "无法下达指令", detail: "你没有出战伙伴。" };
  if (attempt?.battleId !== b.id || attempt.actor !== actor) attempt = undefined;
  const events = ordered(b.events.filter(event => event.actor === actor));
  const fresh = (event: Event) => !attempt || (Number.isFinite(event.eventSeq)
    ? event.eventSeq > attempt.baselineSeq
    : event.tick >= attempt.baselineTick && !attempt.baselineEvents.includes(eventKey(event)));
  const active = fighter.activeCommand && fighter.activeCommand.expiresTick > b.tick ? fighter.activeCommand : undefined;
  const receipts = events.filter(event => event.kind === "command" && isCommand(event.command));
  // Failed HTTP validation cannot be upgraded by an older, identical command.
  if (attempt?.delivery === "failed") return {
    phase: "failed", title: "未发送成功", detail: attempt.message || `${attempt.label}未被接收。`, key: keyOf(attempt),
  };
  const receipt = attempt
    ? receipts.find(event => fresh(event) && same(event, attempt!) &&
      (attempt!.expiresTick === undefined || event.expiresTick === attempt!.expiresTick))
    : receipts.at(-1);
  const activeMatches = !!active && (!attempt || same(active, attempt) &&
    (attempt.expiresTick !== undefined ? active.expiresTick === attempt.expiresTick
      : active.expiresTick !== attempt.baselineActiveExpiry));
  const inferred = receipt && isCommand(receipt.command) ? { command: receipt.command, moveId: receipt.moveId } :
    activeMatches ? active : !attempt && fighter.captureMode ? { command: fighter.captureMode } : undefined;
  const command = attempt ?? inferred;
  if (!command) return b.status === "finished"
    ? { phase: "ended", title: "对战已结束", detail: "本场已停止接收指令。" }
    : { phase: "idle", title: "指令待命", detail: "选择技能或战术；伙伴会在行动条件允许时执行。" };
  const key = keyOf(command);
  const label = attempt?.label || fighter.commandOptions?.find(option => same(option, command))?.label ||
    (command.command === "move" ? fighter.moves?.find(move => move.id === command.moveId)?.name : undefined) || labels[command.command];
  const result = (phase: string, title: string, detail: string): CommandFeedback => ({ phase, title, detail, key });
  const start = receipt ? events.indexOf(receipt) : -1;
  const following = start < 0 ? [] : events.slice(start + 1);
  const replacementIndex = following.findIndex(event => event.kind === "command");
  const interval = replacementIndex < 0 ? following : following.slice(0, replacementIndex);
  const end = interval.find(event => event.kind === "commandEnd" && same(event, command));
  const expiresTick = receipt?.expiresTick ?? attempt?.expiresTick ?? (activeMatches ? active?.expiresTick : undefined);
  const accepted = !!receipt || activeMatches || attempt?.delivery === "accepted" ||
    (!attempt && !!fighter.captureMode && fighter.captureMode === command.command);
  const oneShot = command.command === "move" || command.command === "dodge";
  const persistent = command.command === "hold" || command.command === "weaken";
  if (oneShot && end?.reason === "executed") return result("executed", "已执行", command.command === "move"
    ? `已开始施放${label}；命中结果以战况为准。` : "已开始躲避动作。");
  // Terminal battle state does not prove that a queued action ever started.
  if (b.status === "finished" || fighter.hp <= 0) return result("ended", b.status === "finished" ? "对战已结束" : "伙伴已倒下",
    oneShot ? `${label}已停止等待，未确认执行。` : `${label}已结束。`);
  if (!accepted) {
    if (attempt?.delivery === "sending") return result("sending", "正在发送", `正在传达${label}。`);
    return result("uncertain", "送达待确认", "连接中断，正在根据战况核对；尚不能确认指令是否送达。");
  }
  if (persistent && fighter.captureMode === command.command) return result("persistent", "持续策略已生效", command.command === "hold"
    ? "停手保命：停止进攻并闪避，直到下达其他策略。" : "控血：低血或没有安全招式时停止进攻，直到下达其他策略。");
  if (replacementIndex >= 0) return result("superseded", "已被新指令替换", `${label}之后已收到其他指令。`);
  if (persistent) {
    // A receipt can arrive before its corresponding state snapshot.
    if (attempt?.delivery === "accepted" && !receipt) return result("tactic", "策略已设置", `${label}已接收，等待战况同步。`);
    return result("ended", "持续策略已结束", `${label}已不再启用。`);
  }
  if (oneShot && !receipt && !activeMatches && typeof expiresTick === "number" && b.tick >= expiresTick)
    return result("uncertain", "执行结果待确认", `${label}的有效期已结束，但当前战况中没有保留执行结果。`);
  if (end?.reason === "expired" || typeof expiresTick === "number" && b.tick >= expiresTick) return oneShot
    ? result("expired", "未执行·已过期", `${label}在有效期内未满足执行条件。`)
    : result("ended", "战术有效期已结束", `${label}的本次指令有效期已结束。`);
  if (!oneShot) return result("tactic", "战术已设置", `${label}已接收，在指令有效期内影响伙伴的决策。`);
  if (receipt && !activeMatches && !end) return result("uncertain", "执行结果待确认", `${label}已接收，当前战况未提供执行结果。`);
  return result("waiting", "已接收·等待执行", `${label}正在等待行动条件满足。`);
}
