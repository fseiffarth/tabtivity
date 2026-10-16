/**
 * The pure half of the goal-driven "How to start": which pages a set of
 * answers pulls into the route, which lessons it recommends, and how the
 * answers are remembered.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  INTRO_GOALS,
  INTRO_GOAL_DEFS,
  INTRO_PAGES,
  effectiveGoals,
  firstRecommendedLesson,
  introRoute,
  readIntroGoals,
  recommendedLessons,
  toggleGoal,
  writeIntroGoals,
  type IntroGoal,
} from "../../components/layout/intro/introData";
import { LESSONS, TOUR_LESSON_ID } from "../../lib/lessons";
import { en } from "../../lib/i18n";
import { storageKey } from "../../lib/brand";

const GOALS_KEY = storageKey("intro.goals");
const english = en as Record<string, string>;

describe("introRoute", () => {
  it("no goals is the full explore route, as before", () => {
    expect(introRoute([])).toEqual(["welcome", "goals", "projects", "agents", "localModels", "forYou", "askApp", "done"]);
    expect(introRoute([])).toEqual(introRoute(["explore"]));
    expect(effectiveGoals([])).toEqual(["explore"]);
  });

  it("a goal without setup pages skips straight to For you", () => {
    expect(introRoute(["organize"])).toEqual(["welcome", "goals", "forYou", "askApp", "done"]);
    expect(introRoute(["phone"])).toEqual(["welcome", "goals", "forYou", "askApp", "done"]);
  });

  it("localAi pulls in Local models only", () => {
    const route = introRoute(["localAi"]);
    expect(route).toContain("localModels");
    expect(route).not.toContain("projects");
    expect(route).not.toContain("agents");
  });

  it("merges several goals' pages once, in canonical order", () => {
    expect(introRoute(["code", "write"])).toEqual(["welcome", "goals", "projects", "agents", "forYou", "askApp", "done"]);
    // Order of the answers does not matter.
    expect(introRoute(["write", "code"])).toEqual(introRoute(["code", "write"]));
    expect(introRoute(["localAi", "code"])).toEqual([
      "welcome", "goals", "projects", "agents", "localModels", "forYou", "askApp", "done",
    ]);
  });

  it("every route starts welcome, goals and ends forYou, askApp, done — no duplicates, canonical order", () => {
    const sets: IntroGoal[][] = [[], ...INTRO_GOALS.map((g) => [g]), [...INTRO_GOALS]];
    for (const goals of sets) {
      const route = introRoute(goals);
      expect(route.slice(0, 2), goals.join(",")).toEqual(["welcome", "goals"]);
      expect(route.slice(-3), goals.join(",")).toEqual(["forYou", "askApp", "done"]);
      expect(new Set(route).size, goals.join(",")).toBe(route.length);
      const positions = route.map((p) => INTRO_PAGES.indexOf(p));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  it("each single goal's route holds exactly its own setup pages", () => {
    for (const g of INTRO_GOALS) {
      const middle = introRoute([g]).slice(2, -3);
      const expected = INTRO_PAGES.filter((p) => INTRO_GOAL_DEFS[g].pages.includes(p));
      expect(middle, g).toEqual(expected);
    }
  });
});

describe("recommendedLessons", () => {
  it("no goals falls back to the explore lessons, the tour first", () => {
    expect(recommendedLessons([])).toEqual([{ goal: "explore", lessonIds: [...INTRO_GOAL_DEFS.explore.lessons] }]);
    expect(firstRecommendedLesson([])).toBe(TOUR_LESSON_ID);
  });

  it("groups by goal in INTRO_GOALS order and drops lessons an earlier goal listed", () => {
    // Given in reverse: the result still follows INTRO_GOALS.
    const groups = recommendedLessons(["organize", "code"]);
    expect(groups.map((g) => g.goal)).toEqual(["code", "organize"]);
    expect(groups[0].lessonIds).toEqual([...INTRO_GOAL_DEFS.code.lessons]);
    expect(groups[1].lessonIds).toEqual([...INTRO_GOAL_DEFS.organize.lessons]);

    const all = recommendedLessons([...INTRO_GOALS]);
    const ids = all.flatMap((g) => g.lessonIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.every((g) => g.lessonIds.length > 0)).toBe(true);
    expect(all.map((g) => g.goal)).toEqual(INTRO_GOALS.filter((g) => all.some((x) => x.goal === g)));
  });

  it("an earlier goal's lesson is not repeated under a later goal", () => {
    // Every pair: the later goal's group never repeats an earlier group's id.
    for (const a of INTRO_GOALS) {
      for (const b of INTRO_GOALS) {
        if (a === b) continue;
        const groups = recommendedLessons([a, b]);
        const ids = groups.flatMap((g) => g.lessonIds);
        expect(new Set(ids).size, `${a}+${b}`).toBe(ids.length);
      }
    }
  });

  it("firstRecommendedLesson is the first group's best lesson", () => {
    expect(firstRecommendedLesson(["organize"])).toBe("mail");
    expect(firstRecommendedLesson(["code"])).toBe("install-agent");
    expect(firstRecommendedLesson(["phone", "localAi"])).toBe("local-model");
  });
});

describe("toggleGoal", () => {
  it("adds and removes, keeping INTRO_GOALS order, without mutating", () => {
    const start: IntroGoal[] = [];
    const one = toggleGoal(start, "organize");
    expect(one).toEqual(["organize"]);
    expect(start).toEqual([]);
    const two = toggleGoal(one, "code");
    expect(two).toEqual(["code", "organize"]);
    expect(toggleGoal(two, "organize")).toEqual(["code"]);
    expect(toggleGoal(toggleGoal(two, "code"), "organize")).toEqual([]);
    let all: IntroGoal[] = [];
    for (const g of [...INTRO_GOALS].reverse()) all = toggleGoal(all, g);
    expect(all).toEqual([...INTRO_GOALS]);
  });
});

describe("read/writeIntroGoals", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips", () => {
    expect(readIntroGoals()).toEqual([]);
    writeIntroGoals(["code", "phone"]);
    expect(JSON.parse(localStorage.getItem(GOALS_KEY) ?? "null")).toEqual(["code", "phone"]);
    expect(readIntroGoals()).toEqual(["code", "phone"]);
  });

  it("garbage JSON and non-arrays read as []", () => {
    for (const raw of ["{not json", "42", '"code"', '{"a":1}', "null"]) {
      localStorage.setItem(GOALS_KEY, raw);
      expect(readIntroGoals(), raw).toEqual([]);
    }
  });

  it("drops unknown ids and non-strings", () => {
    localStorage.setItem(GOALS_KEY, JSON.stringify(["code", "bogus", 3, null, "organize"]));
    expect(readIntroGoals()).toEqual(["code", "organize"]);
  });

  it("writing [] removes the key", () => {
    writeIntroGoals(["write"]);
    expect(localStorage.getItem(GOALS_KEY)).not.toBeNull();
    writeIntroGoals([]);
    expect(localStorage.getItem(GOALS_KEY)).toBeNull();
  });
});

describe("goal definitions", () => {
  it("covers every goal", () => {
    expect(Object.keys(INTRO_GOAL_DEFS).sort()).toEqual([...INTRO_GOALS].sort());
  });

  it("every goal recommends lessons, and every lesson id exists", () => {
    const known = new Set(LESSONS.map((l) => l.id));
    for (const g of INTRO_GOALS) {
      const def = INTRO_GOAL_DEFS[g];
      expect(def.lessons.length, g).toBeGreaterThan(0);
      for (const id of def.lessons) expect(known.has(id), `${g}: ${id}`).toBe(true);
      expect(new Set(def.lessons).size, g).toBe(def.lessons.length);
    }
  });

  it("every goal's pages are setup pages", () => {
    const fixed = new Set(["welcome", "goals", "forYou", "askApp", "done"]);
    for (const g of INTRO_GOALS) {
      for (const p of INTRO_GOAL_DEFS[g].pages) {
        expect(INTRO_PAGES as readonly string[], `${g}: ${p}`).toContain(p);
        expect(fixed.has(p), `${g}: ${p}`).toBe(false);
      }
    }
  });

  it("every goal's title and blurb resolve to English text", () => {
    for (const g of INTRO_GOALS) {
      const { titleKey, blurbKey, icon } = INTRO_GOAL_DEFS[g];
      expect(typeof english[titleKey], `${g} title`).toBe("string");
      expect(english[titleKey].length, `${g} title`).toBeGreaterThan(0);
      expect(typeof english[blurbKey], `${g} blurb`).toBe("string");
      expect(english[blurbKey].length, `${g} blurb`).toBeGreaterThan(0);
      expect(icon.length, `${g} icon`).toBeGreaterThan(0);
    }
    expect(english[INTRO_GOAL_DEFS.organize.titleKey]).toBe("Organize my day");
  });
});
