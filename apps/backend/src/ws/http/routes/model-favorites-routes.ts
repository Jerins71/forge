import { readFile } from "node:fs/promises";
import { MODEL_FAVORITES_LIMITS, type ModelFavoritesResponse } from "@forge/protocol";
import { withEnvironmentRouteAccess } from "../../rpc/http-route-access.js";
import { getSharedModelFavoritesPath } from "../../../swarm/storage/data-paths.js";
import { writeJsonFileAtomic } from "../../../utils/atomic-files.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

export const MODEL_FAVORITES_PATH = "/api/settings/model-favorites";
const METHODS = "GET, PUT, OPTIONS";
const KEY = /^[^:\s]{1,64}::[^\s]{1,256}$/;

export async function readModelFavorites(dataDir: string): Promise<ModelFavoritesResponse> {
  try {
    const parsed = JSON.parse(await readFile(getSharedModelFavoritesPath(dataDir), "utf8")) as { favorites?: unknown };
    const favorites = Array.isArray(parsed.favorites) ? parsed.favorites.filter((key): key is string => typeof key === "string" && KEY.test(key)) : [];
    return { favorites: favorites.slice(0, MODEL_FAVORITES_LIMITS.maxFavorites) };
  } catch {
    return { favorites: [] };
  }
}

let writes: Promise<unknown> = Promise.resolve();

/** Replaces the list; writes are serialized and atomic so concurrent clients never leave partial JSON. */
export async function writeModelFavorites(dataDir: string, body: unknown): Promise<ModelFavoritesResponse> {
  const list = (body as { favorites?: unknown } | null)?.favorites;
  if (!Array.isArray(list) || !list.every((key) => typeof key === "string"))
    throw new Error("favorites must be a list of provider::modelId keys");
  const invalid = list.find((key) => !KEY.test(key));
  if (invalid !== undefined) throw new Error(`Not a provider::modelId key: ${String(invalid).slice(0, 80)}`);
  const favorites = [...new Set(list as string[])];
  if (favorites.length > MODEL_FAVORITES_LIMITS.maxFavorites)
    throw new Error(`favorites holds at most ${MODEL_FAVORITES_LIMITS.maxFavorites} models`);
  const run = writes.then(() => writeJsonFileAtomic(getSharedModelFavoritesPath(dataDir), { version: 1, favorites }));
  writes = run.catch(() => {});
  await run;
  return { favorites };
}

/** Favorite models shared by Forge Desktop, the web UI and the mobile app on one machine. */
export function createModelFavoritesRoutes(options: { dataDir: string }): HttpRoute[] {
  return withEnvironmentRouteAccess([{
    methods: METHODS,
    matches: (pathname) => pathname === MODEL_FAVORITES_PATH,
    handle: async (request, response) => {
      applyCorsHeaders(request, response, METHODS);
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "GET") {
        sendJson(response, 200, await readModelFavorites(options.dataDir));
        return;
      }
      if (request.method === "PUT") {
        try {
          sendJson(response, 200, await writeModelFavorites(options.dataDir, await readJsonBody(request)));
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid favorites" });
        }
        return;
      }
      response.setHeader("Allow", METHODS);
      sendJson(response, 405, { error: "Method Not Allowed" });
    },
  }], { GET: { scopes: ["session:read"] }, PUT: { scopes: ["session:operate"] } });
}
