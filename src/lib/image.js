const hex = (buffer, start, end) =>
  buffer.subarray(start, end).toString("hex").toLowerCase();

export function describeMagic(buffer) {
  if (!buffer || buffer.length < 12) return "trop court";

  if (hex(buffer, 0, 8) === "89504e470d0a1a0a") return "PNG";
  if (hex(buffer, 0, 3) === "ffd8ff") return "JPEG";
  if (hex(buffer, 0, 4) === "47494638") return "GIF";
  if (hex(buffer, 0, 3) === "424946" && hex(buffer, 8, 12) === "57454250") return "WebP";

  const box = hex(buffer, 4, 8);
  if (box === "66747970") {
    return buffer.includes(Buffer.from("mdat", "ascii")) ? "AVIF/HEIF" : "MP4/ftyp sans mdat";
  }
  if (box === "6d646961") return "MIDI/ftyp sans mdat";

  return `inconnu (${hex(buffer, 0, 8)})`;
}

export function isCompleteImage(buffer) {
  if (!buffer || buffer.length < 128) return false;

  if (hex(buffer, 0, 8) === "89504e470d0a1a0a") {
    return buffer.subarray(-8, -4).toString("hex").toLowerCase() === "49454e44";
  }

  if (hex(buffer, 0, 3) === "ffd8ff") {
    return hex(buffer, buffer.length - 2, buffer.length) === "ffd9";
  }

  if (hex(buffer, 0, 4) === "47494638") {
    return buffer[buffer.length - 1] === 0x3b;
  }

  if (hex(buffer, 0, 4) === "52494646" && hex(buffer, 8, 12) === "57454250") {
    const declared = buffer.readUInt32LE(4) + 8;
    return declared === buffer.length;
  }

  if (hex(buffer, 4, 8) === "66747970") {
    return buffer.includes(Buffer.from("mdat", "ascii"));
  }

  return false;
}
