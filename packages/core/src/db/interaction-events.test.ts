import { expect, test } from "bun:test";
import { computeNorthStarScorecard, insertInteractionEvent } from "./interaction-events.ts";
import { insertQueryCache, scoreQueryCache } from "./query-cache.ts";
import { createTestDb } from "../../test/support/db.ts";

test("computeNorthStarScorecard summarizes ask follow-ups and maintenance loops", () => {
  const db = createTestDb();
  try {
    const base = Date.now() - 24 * 60 * 60 * 1000;
    const at = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000).toISOString();

    insertQueryCache(db, {
      id: "ASK1",
      queryText: "how auth works",
      resultJson: "{}",
      createdAt: at(0),
    });
    insertQueryCache(db, {
      id: "ASK2",
      queryText: "where auth drifted",
      resultJson: "{}",
      createdAt: at(300),
    });
    insertQueryCache(db, {
      id: "ASK3",
      queryText: "payments",
      resultJson: "{}",
      createdAt: at(600),
    });

    insertInteractionEvent(db, {
      resultId: "ASK1",
      eventType: "ask",
      subject: "how auth works",
      meta: { primary_action: "show", stale_warning: false },
      createdAt: at(0),
    });
    insertInteractionEvent(db, {
      resultId: "ASK1",
      eventType: "show",
      subject: "auth-model",
      createdAt: at(60),
    });
    insertInteractionEvent(db, {
      resultId: "ASK1",
      eventType: "recall",
      subject: "sources",
      createdAt: at(120),
    });

    insertInteractionEvent(db, {
      resultId: "ASK2",
      eventType: "ask",
      subject: "where auth drifted",
      meta: { primary_action: "recall", stale_warning: true },
      createdAt: at(300),
    });
    insertInteractionEvent(db, {
      resultId: "ASK2",
      eventType: "recall",
      subject: "sources",
      createdAt: at(330),
    });

    insertInteractionEvent(db, {
      resultId: "ASK3",
      eventType: "ask",
      subject: "payments",
      meta: { primary_action: "show", stale_warning: false },
      createdAt: at(600),
    });

    insertInteractionEvent(db, {
      eventType: "open_narrative",
      subject: "auth-fix",
      createdAt: at(700),
    });
    insertInteractionEvent(db, {
      eventType: "close_narrative",
      subject: "auth-fix",
      createdAt: at(760),
    });
    insertInteractionEvent(db, {
      eventType: "open_narrative",
      subject: "payment-research",
      createdAt: at(820),
    });

    expect(scoreQueryCache(db, "ASK1", 5)).toBe(true);
    expect(scoreQueryCache(db, "ASK2", 4)).toBe(true);

    const scorecard = computeNorthStarScorecard(db, { windowDays: 30 });
    expect(scorecard.asks_observed).toBe(3);
    expect(scorecard.first_answer_actionability.value).toBeCloseTo(2 / 3);
    expect(scorecard.time_to_first_guided_action.median_seconds).toBeCloseTo(45);
    expect(scorecard.investigation_reuse.value).toBeCloseTo(2 / 3);
    expect(scorecard.next_action_clarity.value).toBe(1);
    expect(scorecard.stale_answer_follow_through.value).toBe(1);
    expect(scorecard.provenance_trust.average_score).toBeCloseTo(4.5);
    expect(scorecard.maintenance_loop_completion.value).toBeCloseTo(0.5);
  } finally {
    db.close();
  }
});
