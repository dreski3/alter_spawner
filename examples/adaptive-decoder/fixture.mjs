export const makeAdaptiveFixture = (secret = "frameworks-can-adapt", shift = 7) => {
  const ciphertext = secret.replace(/[A-Za-z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(base + (character.charCodeAt(0) - base + shift) % 26);
  });
  return {
    input: `CIPHER:caesar-${shift}:${Buffer.from(ciphertext).toString("base64")}`,
    expected: `SECRET:${secret}`,
  };
};
