import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { toPositiveInt } from "../_shared/pagination.ts";
import {
  isGoogleBooksError,
  searchGoogleBooks,
} from "../_shared/googleBooks.ts";

import { findOrCreateBook } from "../_shared/books.ts";

const LOG_LABEL = "search-books";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type CatalogRow = {
  book_id: string;
  popularity: number;
};

type BookRow = {
  id: string;
  name: string;
  author: string;
  genre: string;
  photos: { url: string } | null;
};

type ReadingStatusRow = {
  book_id: string;
  status: "READ" | "WANT_TO_READ";
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405 },
    );
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";

  if (q.length === 1) {
    return Response.json(
      { error: "query_too_short" },
      { status: 400 },
    );
  }

  const page = toPositiveInt(
    url.searchParams.get("page"),
    1,
  );

  const pageSize = Math.min(
    toPositiveInt(
      url.searchParams.get("pageSize"),
      DEFAULT_PAGE_SIZE,
    ),
    MAX_PAGE_SIZE,
  );

  const offset = (page - 1) * pageSize;

  if (!Number.isSafeInteger(offset) || offset > 2147483647) {
    return Response.json(
      { error: "invalid_pagination" },
      { status: 400 },
    );
  }

  const authUserId = ctx.userClaims?.id;

  if (!authUserId) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401 },
    );
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    return dbError("profile", profileError);
  }

  if (!profile) {
    return Response.json(
      { error: "user_profile_not_found" },
      { status: 404 },
    );
  }

  let { data: catalogData, error: catalogError } = await ctx.supabaseAdmin.rpc(
    "search_books_catalog",
    {
      p_query: q || null,
      p_offset: offset,
      p_limit: pageSize + 1,
    },
  );

  if (catalogError) {
    return dbError("catalog", catalogError);
  }

  if (q && page === 1 && (catalogData ?? []).length < pageSize) {
    const googleResults = await searchGoogleBooks(q, LOG_LABEL);

    if (isGoogleBooksError(googleResults)) {
      console.error(
        `${LOG_LABEL} google books error`,
        googleResults.error,
      );
    } else {
      let databaseFailure: Response | null = null;

      for (const suggestion of googleResults) {
        const result = await findOrCreateBook(
          ctx,
          suggestion.externalId,
          profile.id,
          LOG_LABEL,
        );

        if (result instanceof Response) {
          if (result.status === 500) {
            databaseFailure = result;
            break;
          }

          // Falhas da API externa não impedem a busca local.
          continue;
        }
      }

      if (databaseFailure) {
        return databaseFailure;
      }

      const refreshed = await ctx.supabaseAdmin.rpc(
        "search_books_catalog",
        {
          p_query: q,
          p_offset: offset,
          p_limit: pageSize + 1,
        },
      );

      catalogData = refreshed.data;
      catalogError = refreshed.error;

      if (catalogError) {
        return dbError("catalog refresh", catalogError);
      }
    }
  }

  const catalog = (catalogData ?? []) as CatalogRow[];
  const hasMore = catalog.length > pageSize;
  const selected = catalog.slice(0, pageSize);

  if (selected.length === 0) {
    return Response.json({
      items: [],
      page,
      page_size: pageSize,
      has_more: false,
    });
  }

  const bookIds = selected.map((item) => item.book_id);

  const [booksResult, statusResult] = await Promise.all([
    ctx.supabaseAdmin
      .from("books")
      .select("id, name, author, genre, photos(url)")
      .in("id", bookIds),

    ctx.supabaseAdmin
      .from("user_books")
      .select("book_id, status")
      .eq("user_id", profile.id)
      .in("book_id", bookIds),
  ]);

  if (booksResult.error) {
    return dbError("books", booksResult.error);
  }

  if (statusResult.error) {
    return dbError("reading status", statusResult.error);
  }

  const books = (booksResult.data ?? []) as unknown as BookRow[];
  const statuses = (statusResult.data ?? []) as ReadingStatusRow[];

  const booksById = new Map(
    books.map((book) => [book.id, book]),
  );

  const statusByBookId = new Map(
    statuses.map((item) => [item.book_id, item.status]),
  );

  const items = selected.flatMap((entry) => {
    const book = booksById.get(entry.book_id);

    if (!book) {
      return [];
    }

    return [{
      id: book.id,
      title: book.name,
      author: book.author,
      genre: book.genre,
      cover_url: book.photos?.url ?? null,
      my_status: statusByBookId.get(book.id) ?? null,
    }];
  });

  return Response.json({
    items,
    page,
    page_size: pageSize,
    has_more: hasMore,
  });
}));

function dbError(
  label: string,
  error: { message: string },
): Response {
  console.error(
    `${LOG_LABEL} ${label} error`,
    oneLine(error.message),
  );

  return Response.json(
    { error: "Unable to search books" },
    { status: 500 },
  );
}
