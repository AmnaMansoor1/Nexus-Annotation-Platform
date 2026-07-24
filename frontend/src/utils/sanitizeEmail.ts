export function sanitizeEmailForDocId(email: string | null | undefined): string {
  if (!email) return "";
  let e = email.toLowerCase().trim();
  e = e
    .replaceAll("/", "_SLASH_")
    .replaceAll("\\", "_BSLASH_")
    .replaceAll("..", "_DOTDOT_")
    .replaceAll("~", "_TILDE_")
    .replaceAll("*", "_STAR_")
    .replaceAll("[", "_LSQB_")
    .replaceAll("]", "_RSQB_")
    .replaceAll("#", "_HASH_")
    .replaceAll("?", "_QMARK_")
    .replaceAll("%", "_PCT_");
  if (e.startsWith(".") || e.startsWith("_") || e.startsWith("-")) {
    e = "u_" + e;
  }
  e = e.replace(/\.$/g, "_DOT");
  return e;
}
