/* zcode-workflow
description: "Ночной AFK-конвейер реализации: берёт задачи из
  docs/tasks/STATUS.md по зависимостям; для каждой — ветка от main,
  TDD-реализация, независимое ревью, правки, приёмка §20/§24, gate pnpm
  test+typecheck, мердж --no-ff в main и push. Окно 18:00–05:30: новые задачи не
  стартуют после cutoffHour (по умолчанию 05:30 — решение 02.10, было 04:00),
  начатая доделывается (обычно до ~07:00). Утренний предел: с 08:00 до 12:00
  новые задачи не начинаются — начатая доделывается; при force не действует.
  Сбой на задаче блокирует только её — ночь продолжается."
whenToUse: "Вечерний запуск на ночь из воркспейса репозитория: «Запусти workflow
  night-cycle до 05:30» (окно 18:00–05:30). Днём — только с force=true. Требует
  чистого рабочего дерева и запущенной машины (без сна)."
args:
  cutoffHour:
    type: number
    description: "Локальный час, после которого конвейер не начинает новые задачи
      (5.5 = новые задачи не стартуют с 05:30 — решение 02.10; начатая задача
      спокойно доводится до конца, обычно до ~07:00). Окно запуска: после 18:00
      или до cutoffHour."
    required: false
    default: 5.5
  force:
    type: boolean
    description: "true — игнорировать все проверки времени (ночное окно 18:00–05:30
      и утренний предел 08:00–12:00): запуск в любое время, новые задачи без
      часового лимита — остановка по исчерпанию реестра, лимиту задач или
      вручную."
    required: false
    default: false
*/
interface ImplResult {
  /** "done" — ветка готова к ревью; "blocked" — продолжать честно невозможно. */
  status: "done" | "blocked";
  /** Два-три предложения: что сделано, какие неизбежные сопутствующие правки. */
  summary: string;
  /** Короткие хэши коммитов на ветке. */
  commits: string[];
  /** Чем проверялось: команды и их итог. */
  tests: string;
  /** Причина блокировки (заполняется при status="blocked"). */
  blockedReason: string;
}
interface ReviewResult {
  /** "approve" — блокирующих замечаний нет; "fix" — есть. */
  verdict: "approve" | "fix";
  /** Блокирующие замечания: файл, что не так, почему важно. При approve — пусто. */
  issues: string[];
}
interface VerifyResult {
  /** "pass" — все критерии подтверждены доказательствами; "fail" — есть непокрытые. */
  verdict: "pass" | "fail";
  /** Пункт критерия → чем подтверждён (команда/вывод/файл:строки). */
  evidence: string[];
  /** Неподтверждённые критерии (при fail). */
  failures: string[];
}
interface GitOutcome {
  /** true — последовательность выполнена полностью. */
  ok: boolean;
  /** Короткий хэш merge-коммита или пусто. */
  commit: string;
  /** true — push в origin прошёл. */
  pushed: boolean;
}
interface TaskOutcome {
  taskId: string;
  status: "done" | "blocked";
  rounds: number;
  note: string;
}
interface TaskMeta { id: string; title: string; file: string; deps: string[] }
interface LedgerRow { id: string; status: string }
interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}
interface WorkflowReport {
  conclusion: string;
  findings: Finding[];
  verified: string[];
  notCovered: string[];
}

const cutoffHour = typeof args.cutoffHour === "number" ? args.cutoffHour : 4;
const force = args.force === true;
// Утренний предел (требование пользователя «марафон останавливается к утру»):
// в 08:00–12:00 новые задачи не стартуют, начатая доделывается. force=true обходит
// утренний предел наравне с ночным окном.
const morningStopHour = 8;

artifact.board("progress", {
  title: "Ход ночного цикла",
  key: "taskId",
  status: "status",
  columns: ["done", "blocked"],
  cardTitle: "taskId",
  detail: [{ field: "rounds", label: "Раунды правок" }, { field: "note", label: "Заметка" }],
});

const IMPL_SYSTEM = [
  "Ты — ведущий TypeScript/Electron-инженер проекта health-log (Windows, Git Bash, node 20, pnpm 9, pnpm-workspace).",
  "Работаешь строго по TDD: сначала падающий тест (RED), потом минимальная реализация (GREEN), потом рефакторинг; коммит после каждого осмысленного шага, сообщения — conventional commits на русском.",
  "Спецификация задачи самодостаточна: §5 — объём (включено/не включено), §6 — файлы, §13 — бизнес-правила, §14 — безопасность, §19 — тесты, §20 — критерии приёмки, §24 — проверка.",
  "Правила: держись §5 и не трогай чужие задачи; не изменяй docs/tasks/STATUS.md; не мерджи, не пуши, не переключайся на main; минимальные неизбежные сопутствующие правки (корневые конфиги, индексные файлы) описывай в summary.",
  "Если pnpm отсутствует — включи corepack (corepack enable, corepack prepare pnpm@9 --activate); если node_modules нет — pnpm install.",
  "Windows Smart App Control включён и блокирует загрузку неподписанных нативных бинарей без репутации. Признаки: «An Application Control policy has blocked this file», «Cannot find native binding», ERR_DLOPEN_FAILED у свежескачанных .node/.exe. Это среда, а не баг кода: НЕ переустанавливай и не меняй зависимости, не понижай версии, не ищи обход — верни status=blocked с причиной вида «SAC блокирует <пакет/файл>; нативную часть принимать в CI». Если задача в §5 требует нового нативного пакета — сначала пробная загрузка (node -e require) до вкапывания в работу.",
  "Перед завершением прогони pnpm test и pnpm typecheck (и pnpm lint, если скрипт есть) и запиши итог в tests.",
  "Если продолжать честно невозможно (сеть, окружение, противоречие в спеке) — закоммить сделанное на ветке и верни status=blocked с конкретной причиной; не выдумывай проходное решение и не имитируй успех.",
  "Сомневаешься в трактовке спеки — прими разумное толкование в её духе и опиши его в summary.",
].join(" ");

const REVIEW_SYSTEM = [
  "Ты — строгий независимый code-ревьюер: этот код ты не писал.",
  "Ревьюешь диф ветки против main на соответствие спецификации. Не редактируй ни одного файла и не переключай ветки; читать код и спеку и запускать точечные команды можно, полный suite не гоняй — его после тебя прогоняет конвейер.",
  "Ищи: расхождение со спецификацией (лишнее или пропущенное из §5/§6), слабые и таутологические тесты (проверяют поведение или фактируют реализацию), ошибки бизнес-логики (§13), дыры безопасности (§14), нарушение границ слоёв (@hl/*, docs/architecture/03-modules.md), необработанные edge-cases из §7.",
  "Стиль, вкусовщина и альтернативные реализации той же логики — не блокирующее, в issues не включай.",
  "verdict=fix — только когда замечание реально валит критерии приёмки §20, ломает поведение или безопасность; каждое issue конкретно: файл, что не так, почему важно.",
  "Approve подтверждай ссылками на конкретные места кода. Проверить честно не можешь — скажи прямо в issues, не имитируй проверку.",
].join(" ");

const VERIFY_SYSTEM = [
  "Ты — независимый приёмщик: код писали и ревьюили без тебя.",
  "Работаешь на ветке задачи; не редактируй файлы и не переключай ветки.",
  "Проверь: (1) каждый критерий §20 — по пунктам, с доказательством: команда и вывод, файл и строки, либо честное «не подтверждено»; (2) автоматические проверки §24 — выполни описанные там команды, приложи вывод; (3) §5 «Не включено» — в дифе нет лишнего.",
  "Полный suite (pnpm test, pnpm typecheck) после тебя прогоняет конвейер — не дублируй, кроме случаев, когда критерий §24 требует своей команды.",
  "verdict=fail, если хотя бы один критерий не подтверждён: недоказанное — не подтверждено. В evidence компактно, но конкретно.",
  "Критерий физически невозможно проверить (нет железа/сети) — включи в failures с пометкой почему; не засчитывай по-доброму.",
  "Сбой вида «An Application Control policy has blocked this file» / «Cannot find native binding» / ERR_DLOPEN_FAILED на свежескачанных нативных файлах — это Windows Smart App Control (среда, не код): включи затронутые критерии в failures с пометкой «SAC, приёмка в CI», не пытайся обойти переустановками и не имитируй проверку.",
].join(" ");

const INTEGRATOR_SYSTEM = [
  "Ты — релиз-инженер конвейера: выполняешь точные последовательности git-команд, без самодеятельности и без правок кода.",
  "Мердж задачи: (1) на ветке задачи обнови в docs/tasks/STATUS.md только её строку (статус, примечание); (2) коммит лиджера; (3) git checkout main и git merge --no-ff <ветка>; (4) git push origin main — если push не прошёл (сеть/ssh), это не сбой: продолжай и верни pushed=false; (5) git branch -d <ветка>.",
  "Блокировка: на main обнови только строку задачи (статус blocked, причина в примечании), коммит, push origin main best-effort; затем git push origin <ветка> best-effort, чтобы наработки сохранились.",
  "При конфликте мерджа (возникнуть не должен): git merge --abort и верни ok=false с описанием. Ничего сверх указанного не делай.",
].join(" ");

interface LedgerState { rows: LedgerRow[]; meta: Map<string, TaskMeta> }

function parseLedger(text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const m of text.matchAll(/^\| (TASK-\d+) \| ([a-z-]+)/gm)) {
    rows.push({ id: m[1], status: m[2] });
  }
  return rows;
}

async function buildMeta(): Promise<Map<string, TaskMeta>> {
  const map = new Map<string, TaskMeta>();
  const titles = await files.grep("^# TASK-", "docs/tasks/TASK-*.md");
  for (const t of titles) {
    const idM = t.path.match(/TASK-\d+/);
    if (idM === null) continue;
    const id = idM[0];
    if (!map.has(id)) {
      map.set(id, { id, title: t.text.replace(/^#\s*TASK-\d+:\s*/, "").trim(), file: t.path, deps: [] });
    }
  }
  const depLines = await files.grep("^\\| Зависимости \\|", "docs/tasks/TASK-*.md");
  for (const d of depLines) {
    const idM = d.path.match(/TASK-\d+/);
    if (idM === null) continue;
    const m = map.get(idM[0]);
    if (m === undefined) continue;
    m.deps = d.text.match(/TASK-\d+/g) ?? [];
  }
  return map;
}

function inWindow(hour: number): boolean {
  return hour >= 18 || hour < cutoffHour;
}

async function localHour(): Promise<number | null> {
  try {
    const r = await world.run("node", ["-e", "console.log(new Date().getHours() + new Date().getMinutes() / 60)"]);
    if (r.exitCode === 0) {
      const v = parseFloat(r.stdout.trim());
      if (!Number.isNaN(v)) return v;
    }
  } catch {
    // node недоступен — пробуем PowerShell
  }
  try {
    const p = await world.run("powershell", ["-NoProfile", "-Command", "(Get-Date).Hour + (Get-Date).Minute / 60"]);
    if (p.exitCode === 0) {
      const v = parseFloat(p.stdout.trim());
      if (!Number.isNaN(v)) return v;
    }
  } catch {
    // часы недоступны совсем
  }
  return null;
}

async function runGate(): Promise<{ ok: boolean; details: string }> {
  const t = await world.run("cmd", ["/c", "pnpm", "test"], { timeoutMs: 1200000 });
  if (t.exitCode !== 0) return { ok: false, details: "pnpm test упал:\n" + t.stderr.slice(0, 2000) };
  const ty = await world.run("cmd", ["/c", "pnpm", "typecheck"], { timeoutMs: 600000 });
  if (ty.exitCode !== 0) return { ok: false, details: "pnpm typecheck упал:\n" + ty.stderr.slice(0, 2000) };
  return { ok: true, details: "pnpm test и pnpm typecheck зелёные" };
}

function stopReport(conclusion: string, findings: Finding[], notCovered: string[]): WorkflowReport {
  return {
    conclusion,
    findings,
    verified: [],
    notCovered,
  };
}

phase("Готовим репозиторий к ночному циклу");
const checkout = await world.run("git", ["checkout", "main"]);
if (checkout.exitCode !== 0) {
  return stopReport(
    "Ночной цикл не запущен: не удалось переключиться на main (" + checkout.stderr.slice(0, 200) + ").",
    [],
    ["весь реестр задач — цикл не стартовал"],
  );
}
await world.run("git", ["pull", "origin", "main"]);
const status = await world.run("git", ["status", "--porcelain"]);
const dirty = status.stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "" && !s.startsWith("?? .zcode"));
if (dirty.length > 0) {
  return stopReport(
    "Ночной цикл не запущен: рабочее дерево не чистое (" + dirty.slice(0, 5).join("; ") + ").",
    [],
    ["весь реестр задач — цикл не стартовал"],
  );
}
const ledgerText = await files.read("docs/tasks/STATUS.md");
const initialRows = parseLedger(ledgerText);
const meta = await buildMeta();
const initialDone = initialRows.filter((r) => r.status === "done").length;
const orphaned = initialRows.filter((r) => r.status === "in-progress").map((r) => r.id);
log(`Реестр: задач ${initialRows.length}, уже сделано ${initialDone}. План на ночь — по порядку зависимостей.`);
if (orphaned.length > 0) {
  log("Внимание: задачи в статусе in-progress от прерванного прогона пропускаются: " + orphaned.join(", "));
}

const outcomes: TaskOutcome[] = [];
let stopReason = "достигнут лимит задач на прогон (40)";

for (let i = 0; i < 40; i++) {
  phase("Проверяем время и выбираем задачу");
  const hour = await localHour();
  if (hour === null) {
    stopReason = "не удалось определить локальное время — остановка ради гарантии дедлайна";
    break;
  }
  if (!force && !inWindow(hour)) {
    log(`Локальное время ~${hour.toFixed(1)} ч — вне ночного окна (18:00–0${cutoffHour}:00). Новые задачи не начинаю.`);
    stopReason = "время вышло за ночное окно";
    break;
  }
  if (!force && hour >= morningStopHour && hour < 12) {
    log(`Локальное время ~${hour.toFixed(1)} ч — утренний предел (${morningStopHour}:00): новые задачи не начинаю, начатая доделывается.`);
    stopReason = "утро: достигнут утренний предел";
    break;
  }
  const freshRows = parseLedger(await files.read("docs/tasks/STATUS.md"));
  const doneIds = new Set(freshRows.filter((r) => r.status === "done").map((r) => r.id));
  let sel: TaskMeta | null = null;
  for (const row of freshRows) {
    if (row.status !== "todo") continue;
    const m = meta.get(row.id);
    if (m === undefined) continue;
    if (m.deps.every((d) => doneIds.has(d))) {
      sel = m;
      break;
    }
  }
  if (sel === null) {
    log("Подходящих задач больше нет: всё выполнено или заблокировано по зависимостям.");
    stopReason = "реестр исчерпан";
    break;
  }
  log(`Задача ${sel.id}: ${sel.title}`);
  const branch = "task/" + sel.id;
  const integrator = agent("int-" + sel.id, { system: INTEGRATOR_SYSTEM });
  let blocked = "";
  let rounds = 0;
  try {
  phase("Реализуем задачу по TDD");
  const impl = agent("impl-" + sel.id, { system: IMPL_SYSTEM });
  const implRes = await impl.ask<ImplResult>(
    `Задача ${sel.id}: ${sel.title}.\n` +
    `Спецификация: ${sel.file} — прочитай целиком перед началом.\n` +
    `Ветка: создай ${branch} от main (если ветка уже существует — это остаток прерванного прогона: удали её git branch -D и создай заново от main).\n` +
    `Работай строго по TDD в рамках §5. Верни итог.`,
  );
  if (implRes.status === "blocked") blocked = implRes.blockedReason;

  if (blocked === "") {
    phase("Ревьюим ветку и вносим правки");
    const rev = agent("rev-" + sel.id, { system: REVIEW_SYSTEM });
    let review = await rev.ask<ReviewResult>(
      `Проанализируй ветку ${branch} (диф против main) для задачи ${sel.id}. Спецификация: ${sel.file}.\n` +
      `Отчёт реализатора: ${implRes.summary}\nВерни вердикт и блокирующие замечания.`,
    );
    while (review.verdict === "fix" && rounds < 2 && blocked === "") {
      rounds++;
      const fixRes = await impl.ask<ImplResult>(
        `Ревью ветки ${branch} вернуло блокирующие замечания. Исправь каждое (по TDD: сначала тест, воспроизводящий замечание, где применимо), закоммить на ветке и верни итог.\nЗамечания:\n- ` +
        review.issues.join("\n- "),
      );
      if (fixRes.status === "blocked") {
        blocked = "реализатор не смог завершить правки по ревью: " + fixRes.blockedReason;
        break;
      }
      review = await rev.ask<ReviewResult>(
        `Реализатор внёс правки (раунд ${rounds}). Проверь ветку ${branch} снова: устранены ли все замечания. Верни вердикт.`,
      );
    }
    if (blocked === "" && review.verdict === "fix") {
      blocked = "не прошло ревью после " + rounds + " раундов правок: " + review.issues.slice(0, 2).join("; ");
    }

    if (blocked === "") {
      phase("Принимаем задачу независимо");
      const ver = agent("ver-" + sel.id, { system: VERIFY_SYSTEM });
      let verdict = await ver.ask<VerifyResult>(
        `Прими задачу ${sel.id} на ветке ${branch}. Спецификация: ${sel.file}.\n` +
        `Пройди §20 и §24 по пунктам с доказательствами. Верни вердикт.`,
      );
      let gate = await runGate();
      let verifyRounds = 0;
      while (verifyRounds < 1 && blocked === "") {
        if (verdict.verdict === "pass" && gate.ok) break;
        verifyRounds++;
        const failureText =
          (verdict.verdict === "fail" ? "Критерии приёмки не подтверждены:\n- " + verdict.failures.slice(0, 5).join("\n- ") : "") +
          (gate.ok ? "" : (verdict.verdict === "fail" ? "\n" : "") + "Gate-проверки:\n" + gate.details);
        const fixRes = await impl.ask<ImplResult>(
          `Приёмка задачи ${sel.id} не прошла. Исправь на ветке ${branch} по TDD, закоммить и верни итог.\n${failureText}`,
        );
        if (fixRes.status === "blocked") {
          blocked = "правки по приёмке не завершены: " + fixRes.blockedReason;
          break;
        }
        verdict = await ver.ask<VerifyResult>(
          `Реализатор исправил замечания приёмки (задача ${sel.id}, ветка ${branch}). Перепроверь проваленные пункты и смежные. Верни вердикт.`,
        );
        gate = await runGate();
      }
      if (blocked === "" && !(verdict.verdict === "pass" && gate.ok)) {
        blocked = verdict.verdict === "fail"
          ? "приёмка не пройдена: " + verdict.failures.slice(0, 2).join("; ")
          : "gate не прошёл: " + gate.details.slice(0, 200);
      }
    }
  }

  if (blocked !== "") {
    phase("Фиксируем блокировку");
    const shortReason = blocked.slice(0, 250);
    const mb = await integrator.ask<GitOutcome>(
      `Задача ${sel.id} («${sel.title}») заблокирована конвейером и НЕ мержится. На main:\n` +
      `1) обнови в docs/tasks/STATUS.md только её строку: статус blocked, в примечании краткая причина;\n` +
      `2) коммит "chore(ledger): ${sel.id} blocked";\n` +
      `3) git push origin main (best-effort);\n` +
      `4) git push origin ${branch} (best-effort), чтобы сохранить наработки.\nВерни результат.`,
    );
    const oc: TaskOutcome = { taskId: sel.id, status: "blocked", rounds, note: shortReason };
    outcomes.push(oc);
    report(oc, "progress");
    log(`${sel.id}: заблокирована — ${shortReason}`);
  } else {
    phase("Мерджим в main и обновляем лиджер");
    const mg = await integrator.ask<GitOutcome>(
      `Задача ${sel.id} («${sel.title}») принята. Проведи мердж:\n` +
      `1) на ветке ${branch} обнови в docs/tasks/STATUS.md только её строку: статус done, примечание «смержена»;\n` +
      `2) коммит "chore(ledger): ${sel.id} done";\n` +
      `3) git checkout main, затем git merge --no-ff ${branch} -m "${sel.id}: ${sel.title}";\n` +
      `4) git push origin main (если не прошёл — не сбой, верни pushed=false);\n` +
      `5) git branch -d ${branch}.\nВерни результат.`,
    );
    const oc: TaskOutcome = {
      taskId: sel.id,
      status: "done",
      rounds,
      note: mg.pushed ? "смержена в main, push ok" : "смержена в main, push не прошёл (осталась локально)",
    };
    outcomes.push(oc);
    report(oc, "progress");
    log(`${sel.id}: смержена в main.`);
  }
  } catch (err) {
    phase("Фиксируем сбой задачи");
    const reason = "технический сбой конвейера: " + String(err).slice(0, 200);
    try {
      const rescue = agent("rescue-" + sel.id, { system: INTEGRATOR_SYSTEM });
      await rescue.ask<GitOutcome>(
        `Задача ${sel.id} («${sel.title}») упала с техническим сбоем на середине конвейера. Приведи репозиторий в порядок и пометь задачу blocked:\n` +
        `1) если в рабочем дереве есть незакоммиченные изменения — закоммить их на текущую ветку ${branch} сообщением "wip: частичная реализация до сбоя";\n` +
        `2) git checkout main;\n` +
        `3) обнови в docs/tasks/STATUS.md только её строку: статус blocked, примечание — причина сбоя;\n` +
        `4) коммит "chore(ledger): ${sel.id} blocked";\n` +
        `5) git push origin main (best-effort);\n` +
        `6) git push origin ${branch} (best-effort).\nВерни результат.`,
      );
    } catch {
      log(`${sel.id}: лиджер после сбоя обновить не удалось — блокировка зафиксирована только в отчёте прогона.`);
    }
    const oc: TaskOutcome = { taskId: sel.id, status: "blocked", rounds, note: reason };
    outcomes.push(oc);
    report(oc, "progress");
  }
}

phase("Подводим итоги ночи");
const recent = await world.run("git", ["log", "--oneline", "-10"]);
const finalRows = parseLedger(await files.read("docs/tasks/STATUS.md"));
const doneTotal = finalRows.filter((r) => r.status === "done").length;
const blockedTotal = finalRows.filter((r) => r.status === "blocked").length;
const remaining = finalRows.filter((r) => r.status === "todo").length;
const doneNow = outcomes.filter((o) => o.status === "done");
const blockedNow = outcomes.filter((o) => o.status === "blocked");

const lines: string[] = [];
lines.push("# Итоги ночного цикла", "");
lines.push(`За прогон: выполнено ${doneNow.length}, заблокировано ${blockedNow.length}. Причина остановки: ${stopReason}.`);
lines.push(`Реестр: done ${doneTotal}, blocked ${blockedTotal}, todo ${remaining} из ${finalRows.length}.`, "");
if (outcomes.length > 0) {
  lines.push("| Задача | Итог | Раунды правок | Примечание |", "|---|---|---|---|");
  for (const o of outcomes) lines.push(`| ${o.taskId} | ${o.status} | ${o.rounds} | ${o.note} |`);
  lines.push("");
}
lines.push("### Последние коммиты main", "", "```", recent.stdout.trim(), "```", "");
lines.push("### Как проверялось", "", "- Каждая задача: независимое ревью + независимая приёмка §20/§24 + gate `pnpm test` и `pnpm typecheck` перед мерджем.", "- Мердж --no-ff в main, push после каждой задачи (мог не пройти при проблемах с сетью).", "");
await artifact.markdown("night-report", lines.join("\n"), {
  title: "Итоги ночного цикла",
  description: `Сделано ${doneNow.length}, заблокировано ${blockedNow.length}, осталось ${remaining}.`,
  primary: true,
});

const findings: Finding[] = [];
for (const o of blockedNow) {
  findings.push({
    where: "task/" + o.taskId,
    what: "Задача заблокирована конвейером: " + o.note,
    evidence: o.note,
    status: "verified",
    severity: "medium",
  });
}
for (const id of orphaned) {
  findings.push({
    where: id,
    what: "Задача осталась in-progress от прерванного прогона и была пропущена",
    evidence: "строка in-progress в docs/tasks/STATUS.md",
    status: "unconfirmed",
    severity: "low",
  });
}
const idList = (arr: TaskOutcome[]) => (arr.length === 0 ? "—" : arr.map((o) => o.taskId).join(", "));
const result: WorkflowReport = {
  conclusion:
    `Прогон завершён (${stopReason}). Выполнено: ${doneNow.length} (${idList(doneNow)}). ` +
    `Заблокировано: ${blockedNow.length} (${idList(blockedNow)}). ` +
    `Всего по реестру: ${doneTotal} из ${finalRows.length}, осталось ${remaining}.`,
  findings,
  verified: [
    "gate pnpm test + pnpm typecheck выполнялся конвейером перед каждым мерджем",
    "каждую ветку ревьюил отдельный субагент-ревьюер",
    "каждую задачу принимал отдельный субагент-приёмщик по §20/§24 спецификации",
    "после каждого мерджа — push origin main (при сбоях сети помечено в примечаниях)",
  ],
  notCovered: [
    "lint и e2e не входили в merge-gate — их прогоняли реализатор/приёмщик по спеке",
    remaining > 0 ? `не тронуты ${remaining} задач реестра (следующие прогоны)` : "реестр исчерпан",
    blockedNow.length > 0 ? "заблокированные ветки сохранены локально и запушены, но не влиты" : "",
  ].filter((s) => s !== ""),
};
return result;
