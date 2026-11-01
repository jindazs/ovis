/**
 * The work board's cards for the header button and the board (components/KanbanBoard.tsx): read
 * once signed in, again every half minute while the board is open or a card waits, and after each
 * of the board's own changes.
 */
import { useCallback, useEffect, useState } from "react";
import type { KanbanCard } from "../../shared/kanban.ts";
import { ApiError, fetchKanban } from "./api.ts";

const REFRESH_MS = 30_000;

export function useKanban(enabled: boolean): { cards: KanbanCard[] | null; error: string | null; reload: () => Promise<void>; open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<KanbanCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const board = await fetchKanban();
      setCards(board.cards);
      setError(null);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  const started = cards?.some((card) => card.column === "active" || card.column === "done") ?? false;
  useEffect(() => {
    if (!enabled) return;
    void reload();
    if (!open && !started) return;
    const timer = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, open, started, reload]);
  return { cards, error, reload, open, setOpen };
}
