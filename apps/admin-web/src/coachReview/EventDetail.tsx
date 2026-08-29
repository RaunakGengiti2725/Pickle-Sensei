import React, { useEffect, useRef, useState } from "react";
import type { CoachReviewData } from "./data";
import type { QueueItem } from "./types";
import { labBox, mono } from "./CoachReviewLab";
import { ReviewForm } from "./ReviewForm";

/** Context shown around the labeled event (matches the queue's replayCommand). */
const PAD_MS = 800;

function Marker({
  tMs,
  padStart,
  padEnd,
  color,
  label,
}: {
  tMs: number;
  padStart: number;
  padEnd: number;
  color: string;
  label: string;
}) {
  const percent = ((tMs - padStart) / (padEnd - padStart)) * 100;
  if (percent < 0 || percent > 100) return null;
  return (
    <div
      title={`${label} @ ${tMs} ms`}
      style={{
        position: "absolute",
        left: `${percent}%`,
        top: 0,
        bottom: 0,
        width: 2,
        background: color,
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * Event clip player: plays the SOURCE bench video (timestamps in queue.json
 * refer to its timeline), scrubs within the padded event window, loops the
 * event bounds, and exposes the current time so the review form can attach
 * evidence timestamps to faults.
 */
export function EventDetail({
  data,
  item,
  onPersisted,
}: {
  data: CoachReviewData;
  item: QueueItem;
  onPersisted: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentMs, setCurrentMs] = useState(item.windowMs.start);
  const [loop, setLoop] = useState(true);
  const [rate, setRate] = useState(0.5);
  const padStart = Math.max(0, item.windowMs.start - PAD_MS);
  const padEnd = item.windowMs.end + PAD_MS;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) {
        const tMs = video.currentTime * 1000;
        setCurrentMs(Math.round(tMs));
        if (loop && !video.paused && tMs > padEnd) video.currentTime = padStart / 1000;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loop, padStart, padEnd]);

  const seek = (tMs: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, tMs) / 1000;
    setCurrentMs(Math.round(tMs));
  };

  const phases = Object.entries(item.bundle.phases ?? {}).filter(
    ([, value]) => typeof value === "number",
  ) as Array<[string, number]>;

  return (
    <div>
      <p style={{ fontFamily: "ui-sans-serif, system-ui" }}>
        <a href="#/coach">← queue</a>
      </p>
      <section style={labBox}>
        <h2>
          {item.queueItemId} — {item.annotatedStrokeV3 ?? "stroke unlabeled"}{" "}
          <span style={{ color: "#6b7a75", fontWeight: 400 }}>({item.strokeFamily} family)</span>
        </h2>
        <p style={{ color: "#42505f", fontSize: 13, maxWidth: 760 }}>
          Bundle: role <strong>{item.bundle.role}</strong> · annotator {item.bundle.annotatorId} rev{" "}
          {item.bundle.revision} (confidence {item.bundle.annotatorConfidence}) ·{" "}
          {item.bundle.analyzable
            ? "analyzable"
            : `NOT analyzable: ${item.bundle.notAnalyzableReason ?? "—"}`}{" "}
          · contact uncertainty {item.bundle.contactUncertainty ?? "—"}
          {item.bundle.eventNote ? <> · note: “{item.bundle.eventNote}”</> : null}
        </p>
        <video
          ref={videoRef}
          src={`/${item.video}`}
          style={{ width: "100%", maxWidth: 760, background: "#000", borderRadius: 8 }}
          onLoadedMetadata={() => seek(padStart)}
          muted
          playsInline
        />
        <div style={{ position: "relative", maxWidth: 760, height: 28, marginTop: 8 }}>
          <input
            type="range"
            min={padStart}
            max={padEnd}
            step={10}
            value={Math.min(Math.max(currentMs, padStart), padEnd)}
            onChange={(e) => seek(Number(e.target.value))}
            style={{ width: "100%", position: "absolute", top: 4, left: 0, zIndex: 2 }}
          />
          <Marker
            tMs={item.windowMs.start}
            padStart={padStart}
            padEnd={padEnd}
            color="#15803d"
            label="event start"
          />
          {item.contactMs !== null && (
            <Marker
              tMs={item.contactMs}
              padStart={padStart}
              padEnd={padEnd}
              color="#b91c1c"
              label="contact"
            />
          )}
          <Marker
            tMs={item.windowMs.end}
            padStart={padStart}
            padEnd={padEnd}
            color="#1d4ed8"
            label="event end"
          />
          {phases.map(([name, tMs]) => (
            <Marker
              key={name}
              tMs={tMs}
              padStart={padStart}
              padEnd={padEnd}
              color="#9ca3af"
              label={`phase: ${name}`}
            />
          ))}
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            fontFamily: "ui-sans-serif, system-ui",
          }}
        >
          <button onClick={() => void videoRef.current?.play()}>play</button>
          <button onClick={() => videoRef.current?.pause()}>pause</button>
          <button onClick={() => seek(currentMs - 33)}>−1f</button>
          <button onClick={() => seek(currentMs + 33)}>+1f</button>
          <button onClick={() => seek(padStart)}>⇤ window</button>
          <button onClick={() => seek(item.windowMs.start)}>event start</button>
          {item.contactMs !== null && (
            <button onClick={() => seek(item.contactMs!)}>contact</button>
          )}
          <button onClick={() => seek(item.windowMs.end)}>event end</button>
          <label>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />{" "}
            loop event
          </label>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
            {[0.25, 0.5, 1].map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <span style={mono}>
            t = {currentMs} ms · event {item.windowMs.start}–{item.windowMs.end} ms · contact{" "}
            {item.contactMs ?? "—"} ms
          </span>
        </div>
        <p style={{ ...mono, color: "#6b7a75" }}>
          markers: <span style={{ color: "#15803d" }}>■ event start</span> ·{" "}
          <span style={{ color: "#b91c1c" }}>■ contact</span> ·{" "}
          <span style={{ color: "#1d4ed8" }}>■ event end</span> ·{" "}
          <span style={{ color: "#9ca3af" }}>■ annotated phases</span> — CLI replay:{" "}
          <code>{item.replayCommand}</code>
        </p>
      </section>
      <ReviewForm
        data={data}
        item={item}
        getCurrentMs={() => currentMs}
        onPersisted={onPersisted}
      />
    </div>
  );
}
