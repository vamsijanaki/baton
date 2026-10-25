export interface FeedFile {
  url: string;
  sha512: string;
  size: number;
  [k: string]: string | number;
}
export interface Feed {
  version: string | null;
  path: string | null;
  sha512: string | null;
  releaseDate: string | null;
  files: FeedFile[];
  extra: Record<string, string>;
}
export const FEED_FILE: string;
export function zipName(version: string): string;
export function parseFeed(text: string): Feed;
export function serializeFeed(feed: Feed): string;
export function sha512b64(file: string): string;
export function refreshFeedEntry(relDir: string, fileName: string): boolean;
export function verifyFeed(relDir: string, version: string): string[];
