import { describe, expect, it } from "vitest";
import { dockModel, dockTimed, type DockAgent } from "../../lib/agents/subagentDock";

const agent = (n: number, extra: Partial<DockAgent> = {}): DockAgent => ({ key: `k${n}`, token: `t${n}`, task: `Task ${n}`, role: "Explore", atWork: true, ...extra });
const tasks = (model: ReturnType<typeof dockModel>) => model.pills.map((pill) => pill.agent.task);

describe("the subagent dock's pills", () => {
  it("draws a pill per subagent at work and folds the finished ones into done", () => {
    const model = dockModel([agent(1), agent(2, { atWork: false }), agent(3)]);
    expect(tasks(model)).toEqual(["Task 1", "Task 3"]);
    expect(model.done).toBe(1);
    expect(model.running.map((a) => a.key)).toEqual(["k1", "k3"]);
    expect(model.finished.map((a) => a.key)).toEqual(["k2"]);
    expect(model.compact).toBe(false);
    expect(model.more).toBe(0);
  });

  it("counts the subagents only earlier turns hold as done", () => {
    expect(dockModel([], { earlier: 4 }).done).toBe(4);
    expect(dockModel([agent(1, { atWork: false })], { earlier: 2 }).done).toBe(3);
    expect(dockModel([agent(1)]).done).toBe(0);
  });

  it("keeps the open one's pill once it has finished", () => {
    const model = dockModel([agent(1, { atWork: false, selected: true }), agent(2, { atWork: false })]);
    expect(tasks(model)).toEqual(["Task 1"]);
    expect(model.done).toBe(2);
  });

  it("turns every pill compact past three, and folds the rest into +N past six", () => {
    expect(dockModel([1, 2, 3].map((n) => agent(n))).compact).toBe(false);
    const four = dockModel([1, 2, 3, 4].map((n) => agent(n)));
    expect(four.compact).toBe(true);
    expect(four.more).toBe(0);
    const six = dockModel([1, 2, 3, 4, 5, 6].map((n) => agent(n)));
    expect(six.pills).toHaveLength(6);
    expect(six.more).toBe(0);
    const seven = dockModel([1, 2, 3, 4, 5, 6, 7].map((n) => agent(n)));
    expect(tasks(seven)).toEqual(["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
    expect(seven.more).toBe(2);
    expect(seven.compact).toBe(true);
  });

  it("never folds the open one away", () => {
    const model = dockModel([1, 2, 3, 4, 5, 6, 7, 8].map((n) => agent(n, n === 7 ? { selected: true } : {})));
    expect(tasks(model)).toEqual(["Task 1", "Task 2", "Task 3", "Task 4", "Task 7"]);
    expect(model.more).toBe(3);
  });

  it("labels a workflow run's phases before each phase's first pill", () => {
    const model = dockModel([
      agent(1, { role: "Survey" }), agent(2, { role: "Survey" }), agent(3, { role: "Review" }), agent(4, { role: "Survey" }),
    ], { phases: true });
    expect(model.pills.map((pill) => pill.phase)).toEqual(["Survey", undefined, "Review", "Survey"]);
    // Not outside a run.
    expect(dockModel([agent(1, { role: "Survey" })]).pills[0].phase).toBeUndefined();
  });

  it("ticks only for a drawn pill at work with a start stamp", () => {
    expect(dockModel([agent(1)]).timed).toBe(false);
    expect(dockModel([agent(1, { at: "not a time" })]).timed).toBe(false);
    expect(dockModel([agent(1, { at: "2026-09-30T08:00:10Z" })]).timed).toBe(true);
    expect(dockTimed({ atWork: false, at: "2026-09-30T08:00:10Z" })).toBe(false);
    expect(dockModel([agent(1, { atWork: false, selected: true, at: "2026-09-30T08:00:10Z" })]).timed).toBe(false);
  });
});
