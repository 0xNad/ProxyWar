export function redactCoworldPlayerUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.searchParams.has("token")) {
    url.searchParams.set("token", "redacted");
  }
  return url.toString();
}
