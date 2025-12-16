
const str = "Ø·Ø¨ Ø§Ù„Ø£Ø³Ù†Ø§Ù†"; // The corrupted string provided by user

console.log("Original:", str);

try {
    const fromLatin1 = Buffer.from(str, 'latin1').toString('utf8');
    console.log("From Latin1:", fromLatin1);
} catch (e) { console.log("Latin1 Error", e); }

try {
    const fromBinary = Buffer.from(str, 'binary').toString('utf8');
    console.log("From Binary:", fromBinary);
} catch (e) { console.log("Binary Error", e); }

// Sometimes it's CP1252 to UTF8? Node buffers don't support windows-1252 directly but latin1 is close.

