const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const rooms = new Map();
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    videoId: room.videoId,
    playing: room.playing,
    position: room.position,
    updatedAt: room.updatedAt,
    members: [...room.members.values()].map(m => ({ id: m.id, name: m.name })),
    chat: room.chat.slice(-60)
  };
}
function broadcastState(room) {
  io.to(room.code).emit("room-state", publicState(room));
}
function parseYouTubeId(input) {
  try {
    const u = new URL(input);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(u.hostname)) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const parts = u.pathname.split("/");
      if (["embed", "shorts", "live"].includes(parts[1])) return parts[2];
    }
  } catch (_) {}
  return null;
}
function currentPosition(room) {
  if (!room.playing) return room.position;
  return room.position + (Date.now() - room.updatedAt) / 1000;
}

io.on("connection", socket => {
  socket.on("create-room", ({ name }, cb) => {
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const member = { id: socket.id, name: String(name || "Host").slice(0, 24) };
    const room = {
      code, hostId: socket.id, members: new Map([[socket.id, member]]),
      videoId: null, playing: false, position: 0, updatedAt: Date.now(), chat: []
    };
    rooms.set(code, room);
    socket.join(code);
    cb?.({ ok: true, code, state: publicState(room) });
  });

  socket.on("join-room", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "الغرفة مش موجودة أو انتهت." });
    const member = { id: socket.id, name: String(name || "Guest").slice(0, 24) };
    room.members.set(socket.id, member);
    socket.join(code);
    cb?.({ ok: true, state: publicState(room) });
    broadcastState(room);
    io.to(code).emit("system-message", `${member.name} انضم للغرفة`);
  });

  socket.on("set-video", ({ videoUrl }, cb) => {
    const room = [...rooms.values()].find(r => r.members.has(socket.id));
    if (!room) return cb?.({ ok: false, error: "انضم لغرفة أولاً." });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: "المضيف فقط يقدر يغيّر الفيديو." });
    const id = parseYouTubeId(String(videoUrl || ""));
    if (!id || !/^[\w-]{11}$/.test(id)) return cb?.({ ok: false, error: "رابط يوتيوب غير صالح." });
    room.videoId = id; room.playing = false; room.position = 0; room.updatedAt = Date.now();
    broadcastState(room); cb?.({ ok: true });
  });

  socket.on("playback", ({ action, position }, cb) => {
    const room = [...rooms.values()].find(r => r.members.has(socket.id));
    if (!room) return cb?.({ ok: false });
    const pos = Number.isFinite(Number(position)) ? Math.max(0, Math.min(Number(position), 86400)) : currentPosition(room);
    room.position = pos;
    room.updatedAt = Date.now();
    if (action === "play") room.playing = true;
    else if (action === "pause" || action === "seek") room.playing = false;
    else return cb?.({ ok: false });
    io.to(room.code).emit("playback-update", {
      action, position: room.position, playing: room.playing, updatedAt: room.updatedAt, by: socket.id
    });
    cb?.({ ok: true });
  });

  socket.on("chat-message", ({ message }, cb) => {
    const room = [...rooms.values()].find(r => r.members.has(socket.id));
    if (!room) return cb?.({ ok: false });
    const text = String(message || "").trim().slice(0, 500);
    if (!text) return cb?.({ ok: false });
    const member = room.members.get(socket.id);
    const item = { id: crypto.randomUUID(), name: member.name, text, time: Date.now() };
    room.chat.push(item);
    if (room.chat.length > 100) room.chat.shift();
    io.to(room.code).emit("new-message", item);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (!room.members.has(socket.id)) continue;
      const member = room.members.get(socket.id);
      room.members.delete(socket.id);
      if (room.hostId === socket.id) {
        const next = room.members.keys().next();
        room.hostId = next.done ? null : next.value;
        if (room.hostId) io.to(code).emit("system-message", "المضيف خرج. تم نقل صلاحية المضيف لعضو آخر.");
      }
      if (room.members.size === 0) rooms.delete(code);
      else {
        io.to(code).emit("system-message", `${member.name} غادر الغرفة`);
        broadcastState(room);
      }
      break;
    }
  });
});

server.listen(PORT, () => console.log(`WatchTogether running on http://localhost:${PORT}`));
