/**
 * LiveHUD
 * Open Source Ableton Live Display for Stages
 * * Powered by: ableton-js (https://github.com/leolabs/ableton-js)
 * Created by: aspidzon (Joaquín Ignacio Martí)
 */
const { Ableton } = require("ableton-js");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const ableton = new Ableton();
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let cachedCues = []; 

let state = {
    order: "",
    title: "ESPERANDO...",
    feat: "",
    nextTitle: "",
    elapsed: "00:00",
    remaining: "00:00",
    remainingMusical: "",
    progress: 0,
    isPlaying: false,
    metronome: false,
    beat: 1,
    cueList: []
};

const parseLocator = (rawName) => {
    // Si es el marcador de silencio, lo tratamos especial
    if (rawName === "#SILENCE#" || rawName === "#/SILENCE#") {
        return { order: "!!!", title: "PANIC SILENCE", feat: "" };
    }

    const regex = /#(\d+)\s*->\s*(.*?)(?:\s*\((.*)\))?$/;
    const match = rawName.match(regex);
    if (match) {
        return {
            order: match[1] || "",
            title: match[2].trim(),
            feat: match[3] ? match[3].trim() : ""
        };
    }
    return { order: "", title: rawName, feat: "" };
};

const formatMusicalTime = (totalBeats) => {
    if (totalBeats < 0) totalBeats = 0;
    const bars = Math.floor(totalBeats / 4);
    const beats = Math.floor(totalBeats % 4) + 1;
    const sixteenths = Math.floor((totalBeats % 1) * 4) + 1;
    return `${bars} : ${beats} : ${sixteenths}`;
};

const updateCuesCache = async () => {
    try {
        const cues = await ableton.song.get("cue_points");
        cachedCues = await Promise.all(cues.map(async (cue) => {
            return {
                name: await cue.get("name"),
                time: await cue.get("time"),
                rawObject: cue 
            };
        }));
        
        // Filtramos para la lista visual (sacamos los de pánico)
        const simpleList = cachedCues
            .map(c => c.name)
            .filter(name => name !== "#SILENCE#" && name !== "#/SILENCE#");

        if (JSON.stringify(simpleList) !== JSON.stringify(state.cueList)) {
            state.cueList = simpleList;
            io.emit("cueList", state.cueList);
        }
    } catch (e) { console.error("Error cache cues:", e); }
};

const init = async () => {
    try {
        await ableton.start();
        console.log("✅ Conectado a Ableton");

        state.metronome = await ableton.song.get("metronome");
        await updateCuesCache();
        
        ableton.song.addListener("cue_points", updateCuesCache);
        
        ableton.song.addListener("is_playing", (isPlaying) => {
            state.isPlaying = isPlaying;
            io.emit("update", state);
        });

        ableton.song.addListener("metronome", (val) => {
            state.metronome = val;
            io.emit("update", state);
        });

        ableton.song.addListener("current_song_time", (time) => {
            let currentCue = null;
            let nextCue = null;

            for (let i = 0; i < cachedCues.length; i++) {
                if (cachedCues[i].time <= time + 0.1) {
                    currentCue = cachedCues[i];
                    nextCue = (i + 1 < cachedCues.length) ? cachedCues[i+1] : null;
                }
            }

            if (currentCue) {
                const parsed = parseLocator(currentCue.name);
                state.order = parsed.order;
                state.title = parsed.title;
                state.feat = parsed.feat;

                if (nextCue) {
                    const parsedNext = parseLocator(nextCue.name);
                    state.nextTitle = parsedNext.title;
                    
                    const duration = nextCue.time - currentCue.time;
                    const currentPos = time - currentCue.time;
                    const remaining = nextCue.time - time;

                    state.progress = Math.max(0, Math.min(1, currentPos / duration));
                    
                    const totalSeconds = currentPos / 2; 
                    const m = Math.floor(totalSeconds / 60);
                    const s = Math.floor(totalSeconds % 60);
                    state.elapsed = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

                    const remSeconds = remaining / 2;
                    const rm = Math.floor(remSeconds / 60);
                    const rs = Math.floor(remSeconds % 60);
                    state.remaining = `${String(rm).padStart(2,'0')}:${String(rs).padStart(2,'0')}`;
                    
                    state.remainingMusical = formatMusicalTime(remaining);

                } else {
                    state.nextTitle = (currentCue.name === "#SILENCE#") ? "LOOP SILENCIO" : "FIN DEL SET";
                    state.remaining = "00:00";
                    state.remainingMusical = "-";
                    state.progress = 0;
                }
            }

            state.beat = Math.floor(time) % 4 + 1;
            io.emit("update", state);
        });

        io.on("connection", (socket) => {
            socket.emit("update", state);
            socket.emit("cueList", state.cueList);

            socket.on("command", async (cmd) => {
                try {
                    // TRANSPORTE
                    if (cmd.type === "play") {
                        const isPlaying = await ableton.song.get("is_playing");
                        if (!isPlaying) await ableton.song.startPlaying();
                        else await ableton.song.stopPlaying();
                    }
                    if (cmd.type === "playOnly") {
                        const isPlaying = await ableton.song.get("is_playing");
                        if (!isPlaying) await ableton.song.startPlaying();
                    }
                    if (cmd.type === "stopOnly") await ableton.song.stopPlaying();

                    // NAVEGACIÓN
                    if (cmd.type === "next") await ableton.song.jumpToNextCue();
                    if (cmd.type === "prev") await ableton.song.jumpToPrevCue();
                    
                    // METRÓNOMO
                    if (cmd.type === "toggleMetronome") {
                        const current = await ableton.song.get("metronome");
                        await ableton.song.set("metronome", !current);
                    }

                    // --- PANICO INTELIGENTE ---
                    if (cmd.type === "panic") {
                        // Intentamos buscar el marcador de silencio
                        const target = cachedCues.find(c => c.name === "#SILENCE#");
                        
                        if (target && target.rawObject) {
                            // Si existe, saltamos ahí y nos aseguramos que reproduzca (para el loop)
                            await target.rawObject.jump();
                            const isPlaying = await ableton.song.get("is_playing");
                            if (!isPlaying) await ableton.song.startPlaying();
                            console.log(⚠️ Pánico: Saltando a #SILENCE#");
                        } else {
                            // Si NO existe, cortamos el audio (Hard Stop)
                            console.log("⚠️ Pánico: No hay #SILENCE#, deteniendo todo.");
                            await ableton.song.stopPlaying();
                        }
                    }

                    // SALTOS
                    if (cmd.type === "jumpIndex") {
                        // Filtramos para ignorar los marcadores de pánico al contar
                        const validCues = cachedCues.filter(c => c.name !== "#SILENCE#" && c.name !== "#/SILENCE#");
                        if (validCues[cmd.index] && validCues[cmd.index].rawObject) {
                            await validCues[cmd.index].rawObject.jump();
                        }
                    }

                    if (cmd.type === "jump") {
                        const target = cachedCues.find(c => c.name === cmd.target);
                        if (target && target.rawObject) {
                            await target.rawObject.jump();
                        }
                    }

                } catch (e) { console.error("Error comando:", e.message); }
            });
        });

        server.listen(3000, () => console.log("🚀 Server listo: http://localhost:3000"));

    } catch (e) { console.error(e); }
};

init();