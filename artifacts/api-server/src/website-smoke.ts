import { executeNativeWebHandler } from "./capabilities/web";

const requestedUrl =
  process.argv.slice(2).find((argument) => argument.startsWith("https://")) ??
  "https://shadows-project.org";
const target = new URL(requestedUrl);
if (target.protocol !== "https:" || target.username || target.password) {
  throw new Error("Pass a public HTTPS URL.");
}

const outcome = await executeNativeWebHandler(
  "website.read",
  { origin: target.origin, url: target.toString() },
  { timeoutMs: 20_000, charLimit: 8_000 },
);

if (!outcome.ok) {
  console.error(outcome.message);
  process.exitCode = 1;
} else {
  console.log(outcome.text);
}