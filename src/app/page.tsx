'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { SsePayload, StepId, StepStatus } from '@/lib/types';

/* ─── Pipeline steps ────────────────────────────────────────────────── */
const STEPS: {
  id: StepId; name: string; label: string; emoji: string;
  tileCol: number; tileRow: number;
  accentColor: string;
}[] = [
  { id: 'research',  name: 'Blacksmith',  label: 'Research',  emoji: '🔨', tileCol: 4, tileRow: 2, accentColor: '#c0392b' },
  { id: 'script',    name: 'Scriptorium', label: 'Script',    emoji: '📜', tileCol: 0, tileRow: 2, accentColor: '#2980b9' },
  { id: 'clip_hunt', name: 'Mine',        label: 'Clip Hunt', emoji: '⛏',  tileCol: 0, tileRow: 3, accentColor: '#7f8c8d' },
  { id: 'voiceover', name: 'Bell Tower',  label: 'Voiceover', emoji: '🔔', tileCol: 4, tileRow: 3, accentColor: '#8e44ad' },
  { id: 'assemble',  name: 'Forge',       label: 'Assemble',  emoji: '🔥', tileCol: 8, tileRow: 2, accentColor: '#e67e22' },
  { id: 'export',    name: 'Gatehouse',   label: 'Export',    emoji: '🚪', tileCol: 8, tileRow: 4, accentColor: '#27ae60' },
];

const STATION_BUILDING_TILES: Record<StepId, readonly [string, string, string, string]> = {
  research:  ['0064', '0065', '0072', '0073'],
  script:    ['0076', '0077', '0088', '0089'],
  clip_hunt: ['0048', '0049', '0060', '0061'],
  voiceover: ['0064', '0065', '0086', '0087'],
  assemble:  ['0066', '0067', '0072', '0073'],
  export:    ['0096', '0097', '0102', '0103'],
};

const TREE_TILE_IDS = ['0004', '0007', '0008', '0016'] as const;

function TreeCluster({ count, seqStart }: { count: number; seqStart: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, j) => {
        const id = TREE_TILE_IDS[(seqStart + j) % 4];
        return (
          <img
            key={`${seqStart}-${j}`}
            src={`/assets/kenney/Tiles/tile_${id}.png`}
            width={48}
            height={48}
            style={{ imageRendering: 'pixelated' }}
            alt=""
          />
        );
      })}
    </>
  );
}
const SHEET = '/assets/kenney/Tilemap/tilemap_packed.png';
const TILE  = 16;
const GAP   = 1;
const SCALE = 3;

function tileStyle(col: number, row: number, scale = SCALE): React.CSSProperties {
  const step = TILE + GAP;
  return {
    width:  TILE * scale,
    height: TILE * scale,
    backgroundImage: `url(${SHEET})`,
    backgroundPosition: `${-(col * step) * scale}px ${-(row * step) * scale}px`,
    backgroundSize: `${12 * step * scale}px ${11 * step * scale}px`,
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated',
    display: 'inline-block',
    flexShrink: 0,
  };
}

function Building2x2({ cols, rows, scale = SCALE }: {
  cols: [number, number]; rows: [number, number]; scale?: number;
}) {
  const s = TILE * scale;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `${s}px ${s}px`, gap: 0 }}>
      {rows.map(r => cols.map(c => (
        <div key={`${c}-${r}`} style={tileStyle(c, r, scale)} />
      )))}
    </div>
  );
}

function Tile({ col, row, scale = SCALE, style }: {
  col: number; row: number; scale?: number; style?: React.CSSProperties;
}) {
  return <div style={{ ...tileStyle(col, row, scale), ...style }} />;
}

/* ─── Types ─────────────────────────────────────────────────────────── */
type PanelType = 'castle' | StepId | null;

/* ─── Main component ────────────────────────────────────────────────── */
export default function Home() {
  const [stepStatuses, setStepStatuses] = useState<Record<StepId, StepStatus>>(
    () => Object.fromEntries(STEPS.map(s => [s.id, 'idle'])) as Record<StepId, StepStatus>
  );
  const [logs,         setLogs]         = useState<string[]>([]);
  const [clips,        setClips]        = useState<string[]>([]);
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const [filename,     setFilename]     = useState<string | null>(null);
  const [isRunning,    setIsRunning]    = useState(false);
  const [openPanel,    setOpenPanel]    = useState<PanelType>(null);
  const [topic,        setTopic]        = useState('');
  const [doneQuest,    setDoneQuest]    = useState<Record<StepId, boolean>>(
    () => Object.fromEntries(STEPS.map(s => [s.id, false])) as Record<StepId, boolean>
  );
  const [frame, setFrame] = useState(0);

  const logBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % 4), 350);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  const handlePayload = useCallback((p: SsePayload) => {
    if (p.type === 'log') {
      setLogs(prev => [...prev, p.message]);
    } else if (p.type === 'step') {
      setStepStatuses(prev => ({ ...prev, [p.step]: p.status }));
      if (p.status === 'done') {
        setDoneQuest(prev => ({ ...prev, [p.step]: true }));
        setTimeout(() => setDoneQuest(prev => ({ ...prev, [p.step]: false })), 2500);
      }
    } else if (p.type === 'clips') {
      setClips(p.paths);
    } else if (p.type === 'done') {
      setDownloadPath(p.downloadPath);
      setFilename(p.filename);
      setIsRunning(false);
    } else if (p.type === 'error') {
      setLogs(prev => [...prev, `ERROR: ${p.message}`]);
      setIsRunning(false);
    }
  }, []);

  const startForge = useCallback(async () => {
    if (!topic.trim() || isRunning) return;
    setIsRunning(true);
    setLogs([]); setClips([]); setDownloadPath(null); setFilename(null);
    setStepStatuses(Object.fromEntries(STEPS.map(s => [s.id, 'idle'])) as Record<StepId, StepStatus>);
    setDoneQuest(Object.fromEntries(STEPS.map(s => [s.id, false])) as Record<StepId, boolean>);
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      });
      if (!res.body) throw new Error('No response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const read = async () => {
        const { done, value } = await reader.read();
        if (done) { setIsRunning(false); return; }
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
        parts.forEach(part => {
          const line = part.replace(/^data: /, '').trim();
          if (!line) return;
          try { handlePayload(JSON.parse(line)); } catch {}
        });
        read();
      };
      read();
    } catch (e) {
      setLogs(prev => [...prev, `ERROR: ${e instanceof Error ? e.message : String(e)}`]);
      setIsRunning(false);
    }
  }, [topic, isRunning, handlePayload]);

  const filteredLogs = (stepId: StepId) => logs.filter(l =>
    stepId === 'clip_hunt' ? /yt-dlp|clip/i.test(l) :
    stepId === 'assemble'  ? /ffmpeg|concat|mux/i.test(l) :
    stepId === 'research'  ? /claude|virality|research|rank/i.test(l) :
    stepId === 'voiceover' ? /elevenlabs|voiceover|tts/i.test(l) :
    stepId === 'script'    ? /script|words/i.test(l) :
    /export|ready|output/i.test(l)
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323:wght@400&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: #1a3a1a; overflow-x: hidden; }

        .world {
          width: 100%; height: 100vh; max-height: 100vh;
          position: relative; overflow: hidden;
          background: #3a7a22;
          font-family: 'Press Start 2P', monospace;
          image-rendering: pixelated;
        }
        .grass-bg {
          position: absolute; inset: 0;
          background-image: url('/assets/kenney/Tiles/tile_0000.png');
          background-repeat: repeat;
          background-size: ${TILE * SCALE}px ${TILE * SCALE}px;
          image-rendering: pixelated;
        }
        .path-v {
          position: absolute;
          left: 50%; transform: translateX(-50%);
          bottom: 0; top: 145px;
          width: ${TILE * SCALE}px;
          background-image: url('/assets/kenney/Tiles/tile_0025.png');
          background-repeat: repeat-y;
          background-size: 100% auto;
          image-rendering: pixelated;
          z-index: 2;
        }
        .ground-strip {
          position: absolute; bottom: 0; left: 0; right: 0;
          height: 20px; background: #5c3a1e; z-index: 1;
        }
        .castle-zone {
          position: absolute; top: 4px;
          left: 50%; transform: translateX(-50%);
          z-index: 10; cursor: pointer;
          display: flex; flex-direction: column; align-items: center; gap: 4px;
          transition: filter .15s;
        }
        .castle-zone:hover { filter: brightness(1.3) drop-shadow(0 0 10px #ffd700bb); }
        .castle-label {
          font-size: 7px; color: #ffd700;
          text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
          white-space: nowrap; letter-spacing: 1px; margin-top: 2px;
        }
        .tree-group { position: absolute; display: flex; gap: 1px; z-index: 3; }
        .station-strip {
          position: absolute; bottom: 8px; left: 0; right: 0;
          display: flex; justify-content: space-around; align-items: flex-end;
          padding: 0 12px; z-index: 5;
        }
        .station {
          display: flex; flex-direction: column; align-items: center; gap: 3px;
          cursor: pointer; position: relative;
          transition: filter .15s;
        }
        .station:hover { filter: brightness(1.3) drop-shadow(0 0 6px #ffd700aa); }
        .station-label {
          font-size: 4px; color: #ffd700;
          text-shadow: 1px 1px 0 #000;
          text-align: center; line-height: 1.9; white-space: nowrap;
        }
        .station-sublabel { font-size: 3px; color: #bbb; display: block; }
        .status-flag {
          position: absolute; top: -20px; left: 50%;
          transform: translateX(-50%);
          display: flex; flex-direction: column; align-items: flex-start;
          pointer-events: none;
        }
        .flag-pole { width: 2px; height: 16px; background: #8B7355; }
        .flag-cloth {
          position: absolute; top: 0; left: 2px;
          width: 11px; height: 7px; opacity: 0; transition: opacity .3s;
        }
        .flag-cloth.running { opacity: 1; background: #4a90d9; animation: flagWave .8s ease-in-out infinite alternate; }
        .flag-cloth.done    { opacity: 0.85; background: #2ecc71; }
        .flag-cloth.error   { opacity: 1; background: #e74c3c; }
        .quest-marker {
          position: absolute; top: -34px; left: 50%; transform: translateX(-50%);
          font-size: 12px; color: #ffd700; text-shadow: 1px 1px 0 #000;
          opacity: 0; pointer-events: none;
          animation: questBob .5s ease-in-out infinite alternate;
        }
        .quest-marker.show { opacity: 1; }
        .glow-overlay {
          position: absolute; inset: 0; pointer-events: none;
          border-width: 2px; border-style: solid;
        }
        .worker {
          position: absolute; z-index: 6;
          display: flex; flex-direction: column; align-items: center;
        }
        .worker-tool { font-size: 10px; animation: toolBob .6s ease-in-out infinite alternate; }

        @keyframes flagWave { from { transform: skewX(-8deg); } to { transform: skewX(8deg); } }
        @keyframes questBob { from { transform: translateX(-50%) translateY(0); } to { transform: translateX(-50%) translateY(-4px); } }
        @keyframes toolBob  { from { transform: rotate(-12deg); } to { transform: rotate(12deg) translateY(-2px); } }
        @keyframes chipBlink { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        @keyframes charWalk  { 0% { transform: translateY(0); } 50% { transform: translateY(-2px); } 100% { transform: translateY(0); } }

        .overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,.9);
          z-index: 200; display: flex; align-items: center; justify-content: center;
        }
        .panel {
          width: 94%; max-width: 580px; background: #0c1a10;
          border: 3px solid #ffd700;
          max-height: 92vh; display: flex; flex-direction: column;
          image-rendering: auto;
        }
        .panel-header {
          background: #162a1c; border-bottom: 2px solid #ffd700;
          padding: 13px 18px; display: flex; align-items: center; justify-content: space-between;
        }
        .panel-title { font-size: 8px; color: #ffd700; letter-spacing: 1px; }
        .panel-close {
          background: none; border: 1px solid #ffd700; color: #ffd700;
          cursor: pointer; font-family: 'Press Start 2P',monospace; font-size: 7px; padding: 4px 8px;
        }
        .panel-close:hover { background: #ffd700; color: #000; }
        .panel-body { padding: 16px; overflow-y: auto; flex: 1; }

        .topic-row { display: flex; gap: 8px; margin-bottom: 14px; }
        .topic-input {
          flex: 1; background: #060f08; border: 2px solid #2a6a3a;
          color: #7aff9a; font-family: 'VT323',monospace; font-size: 20px;
          padding: 7px 10px; outline: none;
        }
        .topic-input:focus { border-color: #ffd700; }
        .topic-input::placeholder { color: #1a4a2a; }
        .topic-input:disabled { opacity: .45; }
        .forge-btn {
          background: #6a1a0a; border: 2px solid #ffd700; color: #ffd700;
          font-family: 'Press Start 2P',monospace; font-size: 6px;
          padding: 7px 11px; cursor: pointer; white-space: nowrap;
        }
        .forge-btn:hover:not(:disabled) { background: #9a2a0a; }
        .forge-btn:disabled { opacity: .45; cursor: not-allowed; }
        .chip-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 5px; margin-bottom: 14px; }
        .chip {
          background: #060f08; border: 1px solid #1a3a1a;
          padding: 7px 6px; font-size: 4px; color: #2a5a2a;
          text-align: center; line-height: 2.2;
        }
        .chip.running { border-color: #f39c12; color: #f39c12; animation: chipBlink 1s ease-in-out infinite; }
        .chip.done    { border-color: #2ecc71; color: #2ecc71; }
        .chip.error   { border-color: #e74c3c; color: #e74c3c; }
        .log-box {
          background: #030908; border: 1px solid #1a3a1a;
          padding: 10px; height: 148px; overflow-y: auto;
          font-family: 'VT323',monospace; font-size: 14px;
          color: #3aaa3a; line-height: 1.5;
        }
        .log-box p { margin: 0; }
        .log-err { color: #e74c3c !important; }
        .download-row { margin-top: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .dl-btn {
          background: #0a3a1a; border: 2px solid #2ecc71; color: #2ecc71;
          font-family: 'Press Start 2P',monospace; font-size: 5px;
          padding: 8px 13px; cursor: pointer; text-decoration: none; display: inline-block;
        }
        .dl-btn:hover { background: #1a5a2a; }
        .video-prev { width: 100%; max-height: 280px; display: block; margin-top: 10px; border: 2px solid #2ecc71; background: #000; }
        .scene-box {
          background: #030908; border: 1px solid #1a3a1a;
          height: 96px; margin-bottom: 12px;
          display: flex; align-items: center; justify-content: center; gap: 20px; overflow: hidden;
        }
        .scene-idle { color: #1a4a1a; font-family: 'VT323',monospace; font-size: 15px; }
        .px-char { display: flex; flex-direction: column; align-items: center; gap: 1px; animation: charWalk .5s ease-in-out infinite; }
        .clips-grid { display: grid; grid-template-columns: repeat(5,1fr); gap: 5px; margin-top: 8px; }
        .clip-cell {
          aspect-ratio: 9/16; background: #030908; border: 1px solid #1a3a1a;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          font-family: 'VT323',monospace; font-size: 10px; color: #1a4a1a; position: relative;
        }
        .clip-cell.loaded { border-color: #2ecc71; color: #2ecc71; }
        .clip-num { position: absolute; top: 2px; left: 3px; font-family: 'Press Start 2P',monospace; font-size: 4px; color: #ffd700; }
      `}</style>

      <div className="world">
        <div className="grass-bg" />
        <div className="path-v" />
        <div className="ground-strip" />

        {/* Tree clusters — left */}
        <div className="tree-group" style={{ left: '3%',  bottom: 200 }}>
          <TreeCluster count={3} seqStart={0} />
        </div>
        <div className="tree-group" style={{ left: '7%',  bottom: 260 }}>
          <TreeCluster count={2} seqStart={3} />
        </div>
        <div className="tree-group" style={{ left: '2%',  bottom: 310 }}>
          <TreeCluster count={2} seqStart={5} />
        </div>
        <div className="tree-group" style={{ left: '11%', bottom: 230 }}>
          <TreeCluster count={2} seqStart={7} />
        </div>

        {/* Tree clusters — right */}
        <div className="tree-group" style={{ right: '3%',  bottom: 200 }}>
          <TreeCluster count={3} seqStart={9} />
        </div>
        <div className="tree-group" style={{ right: '7%',  bottom: 270 }}>
          <TreeCluster count={2} seqStart={12} />
        </div>
        <div className="tree-group" style={{ right: '2%',  bottom: 320 }}>
          <TreeCluster count={2} seqStart={14} />
        </div>
        <div className="tree-group" style={{ right: '11%', bottom: 240 }}>
          <TreeCluster count={2} seqStart={16} />
        </div>

        {/* Rocks / props */}
        <Tile col={3} row={1} style={{ position: 'absolute', left: '16%',  bottom: 178, zIndex: 3 }} />
        <Tile col={2} row={1} style={{ position: 'absolute', right: '18%', bottom: 170, zIndex: 3 }} />
        <Tile col={8} row={1} style={{ position: 'absolute', left: '26%',  bottom: 220, zIndex: 3 }} />
        <Tile col={7} row={1} style={{ position: 'absolute', right: '25%', bottom: 215, zIndex: 3 }} />
        <Tile col={9} row={1} style={{ position: 'absolute', left: '10%',  bottom: 185, zIndex: 3 }} />
        <Tile col={9} row={1} style={{ position: 'absolute', right: '12%', bottom: 188, zIndex: 3 }} />

        {/* Castle — custom tile PNGs */}
        <div className="castle-zone" onClick={() => setOpenPanel('castle')}>
          <div style={{ display: 'flex' }}>
            <img src="/assets/kenney/Tiles/tile_0096.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0097.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0097.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0098.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
          </div>
          <div style={{ display: 'flex' }}>
            <img src="/assets/kenney/Tiles/tile_0060.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0061.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0061.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0062.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
          </div>
          <div style={{ display: 'flex' }}>
            <img src="/assets/kenney/Tiles/tile_0072.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0074.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0074.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
            <img src="/assets/kenney/Tiles/tile_0075.png" width={64} height={64} style={{ imageRendering: 'pixelated' }} alt="" />
          </div>
          <div className="castle-label">⚔ RANKFORGE CASTLE ⚔</div>
        </div>

        {/* Overworld workers */}
        <div className="worker" style={{ left: '19%', bottom: 158 }}>
          <span className="worker-tool">🔨</span>
          <Tile col={0} row={8} scale={2} />
        </div>
        <div className="worker" style={{ left: '44%', bottom: 155 }}>
          <span className="worker-tool" style={{ animationDelay: '.2s' }}>✏️</span>
          <Tile col={1} row={8} scale={2} />
        </div>
        <div className="worker" style={{ right: '21%', bottom: 160 }}>
          <span className="worker-tool" style={{ animationDelay: '.1s' }}>⛏️</span>
          <Tile col={2} row={8} scale={2} />
        </div>

        {/* Station row */}
        <div className="station-strip">
          {STEPS.map(s => {
            const st = stepStatuses[s.id];
            return (
              <div key={s.id} className="station" onClick={() => setOpenPanel(s.id)}>
                <div className={`quest-marker ${doneQuest[s.id] ? 'show' : ''}`}>!</div>
                <div className="status-flag">
                  <div className={`flag-cloth ${st}`} />
                  <div className="flag-pole" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '48px 48px', gap: 0 }}>
                  {STATION_BUILDING_TILES[s.id].map((num, idx) => (
                    <img
                      key={`${s.id}-${idx}`}
                      src={`/assets/kenney/Tiles/tile_${num}.png`}
                      width={48}
                      height={48}
                      style={{ imageRendering: 'pixelated' }}
                      alt=""
                    />
                  ))}
                </div>
                {(st === 'running' || st === 'done') && (
                  <div className="glow-overlay" style={{
                    borderColor: st === 'running' ? `${s.accentColor}99` : '#2ecc7166',
                    background:  st === 'running' ? `${s.accentColor}11` : '#2ecc7108',
                    animation:   st === 'running' ? 'chipBlink 1s ease-in-out infinite' : 'none',
                  }} />
                )}
                <div className="station-label">
                  {s.emoji} {s.name}
                  <span className="station-sublabel">{s.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Panel */}
        {openPanel && (
          <div className="overlay" onClick={e => { if (e.target === e.currentTarget) setOpenPanel(null); }}>
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">
                  {openPanel === 'castle'
                    ? '⚔ RANKFORGE CASTLE'
                    : `${STEPS.find(s => s.id === openPanel)?.emoji} ${STEPS.find(s => s.id === openPanel)?.name.toUpperCase()}`}
                </span>
                <button className="panel-close" onClick={() => setOpenPanel(null)}>✕ CLOSE</button>
              </div>
              <div className="panel-body">
                {openPanel === 'castle'
                  ? <CastlePanel
                      topic={topic} setTopic={setTopic}
                      isRunning={isRunning} startForge={startForge}
                      stepStatuses={stepStatuses} logs={logs}
                      logBoxRef={logBoxRef}
                      downloadPath={downloadPath} filename={filename}
                    />
                  : <StationPanel
                      stepId={openPanel as StepId}
                      status={stepStatuses[openPanel as StepId]}
                      logs={filteredLogs(openPanel as StepId)}
                      clips={clips}
                      frame={frame}
                    />
                }
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Castle panel ──────────────────────────────────────────────────── */
function CastlePanel({ topic, setTopic, isRunning, startForge, stepStatuses, logs, logBoxRef, downloadPath, filename }: {
  topic: string; setTopic: (v: string) => void;
  isRunning: boolean; startForge: () => void;
  stepStatuses: Record<StepId, StepStatus>;
  logs: string[]; logBoxRef: React.RefObject<HTMLDivElement | null>;
  downloadPath: string | null; filename: string | null;
}) {
  return (
    <>
      <div className="topic-row">
        <input
          className="topic-input"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && startForge()}
          placeholder="Enter your topic…"
          disabled={isRunning}
        />
        <button className="forge-btn" onClick={startForge} disabled={isRunning}>
          {isRunning ? '⚙ FORGING…' : '⚔ FORGE'}
        </button>
      </div>
      <div className="chip-grid">
        {STEPS.map(s => (
          <div key={s.id} className={`chip ${stepStatuses[s.id]}`}>
            {s.emoji} {s.name}
            <span style={{ display: 'block', fontSize: 3, marginTop: 3, opacity: .7 }}>
              {stepStatuses[s.id].toUpperCase()}
            </span>
          </div>
        ))}
      </div>
      <div className="log-box" ref={logBoxRef}>
        {logs.length === 0
          ? <p style={{ color: '#1a4a1a' }}>&gt; Awaiting your command, Sire…</p>
          : logs.map((l, i) => <p key={i} className={l.startsWith('ERROR') ? 'log-err' : ''}>&gt; {l}</p>)
        }
      </div>
      {downloadPath && (
        <div className="download-row">
          <a className="dl-btn" href={downloadPath} download={filename ?? undefined}>⬇ DOWNLOAD MP4</a>
          <span style={{ fontFamily: 'VT323,monospace', fontSize: 18, color: '#2ecc71' }}>✓ QUEST COMPLETE!</span>
        </div>
      )}
      {downloadPath && <video className="video-prev" controls src={downloadPath} />}
    </>
  );
}

/* ─── Station panel ─────────────────────────────────────────────────── */
const SCENE_CHARS: Record<StepId, { tool: string; bodyColor: string }[]> = {
  research:  [{ tool: '🔨', bodyColor: '#7a1a1a' }, { tool: '📚', bodyColor: '#8a2a1a' }, { tool: '🔨', bodyColor: '#7a1a1a' }],
  script:    [{ tool: '✏️', bodyColor: '#1a2a7a' }, { tool: '📜', bodyColor: '#2a3a8a' }, { tool: '✏️', bodyColor: '#1a2a7a' }],
  clip_hunt: [{ tool: '⛏️', bodyColor: '#2a2a2a' }, { tool: '⛏️', bodyColor: '#3a3a3a' }, { tool: '⛏️', bodyColor: '#2a2a2a' }],
  voiceover: [{ tool: '🔔', bodyColor: '#3a1a5a' }, { tool: '🎵', bodyColor: '#5a2a7a' }, { tool: '🔔', bodyColor: '#3a1a5a' }],
  assemble:  [{ tool: '🔥', bodyColor: '#7a2a1a' }, { tool: '⚙️', bodyColor: '#5a1a0a' }, { tool: '🔥', bodyColor: '#7a2a1a' }],
  export:    [{ tool: '📦', bodyColor: '#1a5a2a' }, { tool: '🚪', bodyColor: '#2a7a3a' }, { tool: '✓',  bodyColor: '#1a5a2a' }],
};

function StationPanel({ stepId, status, logs, clips, frame }: {
  stepId: StepId; status: StepStatus;
  logs: string[]; clips: string[]; frame: number;
}) {
  const s = STEPS.find(x => x.id === stepId)!;
  const chars = SCENE_CHARS[stepId];
  const statusColor = status === 'running' ? '#f39c12' : status === 'done' ? '#2ecc71' : status === 'error' ? '#e74c3c' : '#2a5a2a';
  const charCol = frame % 2;

  return (
    <>
      <div style={{ fontFamily: "'Press Start 2P',monospace", fontSize: 5, color: statusColor, marginBottom: 10 }}>
        [{status.toUpperCase()}]{status === 'running' ? ' — workers active' : ''}
      </div>
      <div className="scene-box">
        {status === 'idle' && <div className="scene-idle">[ Awaiting orders… ]</div>}
        {status !== 'idle' && chars.map((c, i) => (
          <div
            key={i} className="px-char"
            style={{
              animationDelay: `${i * 0.18}s`,
              animationPlayState: status === 'running' ? 'running' : 'paused',
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>{c.tool}</span>
            <Tile col={charCol} row={8} scale={2} />
          </div>
        ))}
      </div>
      <div className="log-box" style={{ height: 110 }}>
        {logs.length === 0
          ? <p style={{ color: '#1a4a1a' }}>&gt; No activity yet…</p>
          : logs.map((l, i) => <p key={i}>&gt; {l}</p>)
        }
      </div>
      {stepId === 'clip_hunt' && (
        <>
          <div style={{ marginTop: 10, fontFamily: "'Press Start 2P',monospace", fontSize: 4, color: '#2a5a2a', marginBottom: 6 }}>
            CLIP STATUS
          </div>
          <div className="clips-grid">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className={`clip-cell ${clips.length > i ? 'loaded' : ''}`}>
                <span className="clip-num">#{i + 1}</span>
                {clips.length > i ? '✓' : '…'}
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Building2x2
          cols={[s.tileCol, Math.min(s.tileCol + 1, 11) as number]}
          rows={[s.tileRow, Math.min(s.tileRow + 1, 10) as number]}
          scale={2}
        />
        <div>
          <div style={{ fontFamily: "'Press Start 2P',monospace", fontSize: 6, color: '#ffd700', marginBottom: 6 }}>
            {s.emoji} {s.name}
          </div>
          <div style={{ fontFamily: 'VT323,monospace', fontSize: 14, color: '#3aaa3a' }}>
            {s.label} station
          </div>
        </div>
      </div>
    </>
  );
}
