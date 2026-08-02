const input = process.argv[2] || "";
const match = input.match(/^CIPHER:caesar-(\d+):([A-Za-z0-9+/=]+)$/);

if (!match) {
  process.stderr.write("caesar decode failed: expected CIPHER:caesar-<shift>:<base64>\n");
  process.exitCode = 1;
} else {
  const shift = Number(match[1]) % 26;
  const ciphertext = Buffer.from(match[2], "base64").toString("utf8");
  const plaintext = ciphertext.replace(/[A-Za-z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(base + (character.charCodeAt(0) - base - shift + 26) % 26);
  });
  process.stdout.write(`SECRET:${plaintext}`);
}
