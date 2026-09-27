import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "..");
const SETUP_SCRIPT = resolve(ROOT_DIR, "scripts/setup.sh");

let fakeBinDir = "";

beforeEach(async () => {
  fakeBinDir = await mkdtemp(resolve(tmpdir(), "yt-converter-setup-bin-"));
});

afterEach(async () => {
  await rm(fakeBinDir, { recursive: true, force: true });
});

async function runBash(script: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(["bash", "-c", script], {
    cwd: ROOT_DIR,
    env: { PATH: "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function writeFakeBun(version: string) {
  const path = resolve(fakeBinDir, "bun");
  await Bun.write(path, `#!/bin/sh\nprintf '%s\\n' "${version}"\n`);
  await chmod(path, 0o755);
  return path;
}

describe("setup.sh", () => {
  test("is syntactically valid and safe to source", async () => {
    expect(await runBash(`bash -n "${SETUP_SCRIPT}"`)).toMatchObject({
      exitCode: 0,
      stderr: "",
    });

    // Sourcing must expose helpers without running the installer.
    const sourced = await runBash(
      `set +e +u; set +o pipefail; source "${SETUP_SCRIPT}"; if [[ $- == *e* || $- == *u* ]] || shopt -qo pipefail; then exit 1; fi; printf 'sourced %s\\n' "$REQUIRED_BUN_VERSION"`,
    );
    expect(sourced.exitCode).toBe(0);
    expect(sourced.stdout).toBe("sourced 1.4.2\n");
    expect(sourced.stdout).not.toContain("Setup complete");
  });

  test("compares Bun versions without external tools", async () => {
    const cases: Array<[string, string, boolean]> = [
      ["1.3.5", "1.3.6", true],
      ["1.3.6", "1.3.6", false],
      ["1.3.7", "1.3.6", false],
      ["1.2.99", "1.3.6", true],
      ["0.9.9", "1.3.6", true],
      ["2.0.0", "1.3.6", false],
      ["1.4", "1.3.6", false],
      ["1.3", "1.3.6", true],
      ["1.3.6-canary.1", "1.3.6", true],
      ["1.3.7-canary.1", "1.3.6", false],
      ["1.03.06", "1.3.6", false],
      ["10.0.0", "9.9.9", false],
      ["1.3.10", "1.3.9", false],
    ];

    const script = [
      `source "${SETUP_SCRIPT}"`,
      ...cases.map(
        ([left, right]) =>
          `if version_lt "${left}" "${right}"; then echo "${left}<${right} true"; else echo "${left}<${right} false"; fi`,
      ),
    ].join("\n");

    const result = await runBash(script);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual(
      cases.map(([left, right, expected]) => `${left}<${right} ${expected}`),
    );
  });

  test("--check fails on an outdated Bun without touching the host", async () => {
    await writeFakeBun("1.3.5");
    const home = await mkdtemp(resolve(tmpdir(), "yt-converter-setup-home-"));

    try {
      const result = await runBash(`"${SETUP_SCRIPT}" --check`, {
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
        HOME: home,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("1.3.5");
      expect(result.stderr).toContain("1.4.2");
      expect(result.stdout).not.toContain("Installing");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
