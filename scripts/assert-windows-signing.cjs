const certificate = process.env.CSC_LINK || process.env.WIN_CSC_LINK || '';
if (!String(certificate).trim()) {
  process.stderr.write('Windows installer signing is not configured. Set CSC_LINK (or WIN_CSC_LINK) to a certificate before creating a distributable installer.\n');
  process.exit(1);
}
process.stdout.write('Windows installer signing certificate reference is configured; electron-builder will perform the signing step.\n');
