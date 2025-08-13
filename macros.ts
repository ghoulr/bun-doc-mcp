// Bun macro: executed at bundle-time, result inlined into bundle
export async function getPackageVersion() {
  const packageJson = JSON.parse(
    await Bun.file(`${import.meta.dir}/package.json`).text()
  );
  return packageJson.version;
}
