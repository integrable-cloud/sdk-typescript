/**
 * Walking a list endpoint without writing the loop.
 *
 * Every list endpoint returns `{ items, next_cursor, has_more }`. Following
 * the cursor by hand is four lines that everybody writes slightly differently,
 * and the common variant is wrong in the same way: it increments a page number
 * instead. Offset pagination makes Postgres read and discard every skipped
 * row, so page 40 costs forty times page 1 and eventually times out on a busy
 * tenant. Exposing an async iterator makes the correct thing also the shortest
 * thing to write.
 *
 *     for await (const conversation of client.conversations.walk(botId)) {
 *       ...
 *     }
 *
 * Pages are fetched lazily, one ahead of consumption, so `break`ing out of the
 * loop early does not pay for pages nobody read.
 */

export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
  has_more?: boolean;
  total?: number;
}

/** A lazily-fetched sequence over every page of a list endpoint. */
export class Paginator<T> implements AsyncIterable<T> {
  constructor(private readonly fetchPage: (cursor?: string) => Promise<Page<T>>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor: string | undefined;
    // Guards against a server that returns `has_more: true` with the same
    // cursor forever. Without it that is an infinite loop hammering the API,
    // which is a worse failure than stopping early.
    const seen = new Set<string>();

    for (;;) {
      const page = await this.fetchPage(cursor);
      for (const item of page.items ?? []) yield item;

      const next = page.next_cursor;
      if (!page.has_more || !next || seen.has(next)) return;
      seen.add(next);
      cursor = next;
    }
  }

  /**
   * Everything, in one array.
   *
   * Convenient and occasionally a mistake: a busy workspace has hundreds of
   * thousands of conversations, and this holds all of them in memory at once.
   * Iterate instead unless you know the set is small — hence the cap, which
   * fails loudly rather than quietly exhausting the process.
   */
  async all(limit = 10_000): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) {
      out.push(item);
      if (out.length >= limit) {
        throw new Error(
          `Refusing to buffer more than ${limit} items. Iterate the paginator ` +
            `instead of calling .all(), or raise the limit deliberately.`,
        );
      }
    }
    return out;
  }

  /** The first page only, when you want a preview rather than the set. */
  async first(): Promise<T | undefined> {
    for await (const item of this) return item;
    return undefined;
  }
}
