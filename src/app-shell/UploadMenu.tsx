import { useCallback, useEffect, useRef, useState } from 'react';
import { ingestGtfsZip } from '../gtfs/ingest';
import { useAppStore } from '../state/app-store';

type JobStatus = 'pending' | 'running' | 'done' | 'error';

interface Job {
  id: string;
  file: File;
  status: JobStatus;
  error?: string;
}

let jobCounter = 0;
const nextJobId = () => `job_${Date.now().toString(36)}_${(jobCounter++).toString(36)}`;

export default function UploadMenu() {
  const ingesting = useAppStore((s) => s.ingesting);
  const [open, setOpen] = useState(false);
  const [jobs, setJobsState] = useState<Job[]>([]);
  const jobsRef = useRef<Job[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);

  // Single source of truth: jobsRef. `jobs` is a mirror for render.
  const writeJobs = useCallback((updater: (prev: Job[]) => Job[]) => {
    const next = updater(jobsRef.current);
    jobsRef.current = next;
    setJobsState(next);
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const runQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      while (true) {
        const pending = jobsRef.current.find((j) => j.status === 'pending');
        if (!pending) break;

        writeJobs((prev) =>
          prev.map((j) => (j.id === pending.id ? { ...j, status: 'running' } : j)),
        );

        try {
          await ingestGtfsZip(pending.file);
          writeJobs((prev) =>
            prev.map((j) => (j.id === pending.id ? { ...j, status: 'done' } : j)),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`ingest failed for ${pending.file.name}`, err);
          writeJobs((prev) =>
            prev.map((j) =>
              j.id === pending.id ? { ...j, status: 'error', error: msg } : j,
            ),
          );
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [writeJobs]);

  const enqueue = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const newJobs: Job[] = files.map((file) => ({ id: nextJobId(), file, status: 'pending' }));
      writeJobs((prev) => [...prev, ...newJobs]);
      setOpen(true);
      void runQueue();
    },
    [runQueue, writeJobs],
  );

  const onPickFiles = () => fileInput.current?.click();

  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    const files = list ? Array.from(list) : [];
    e.target.value = '';
    enqueue(files);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files ?? []).filter(
      (f) =>
        /\.zip$/i.test(f.name) ||
        f.type === 'application/zip' ||
        f.type === 'application/x-zip-compressed',
    );
    enqueue(files);
  };

  const removeJob = (id: string) => {
    writeJobs((prev) => prev.filter((j) => j.id !== id || j.status === 'running'));
  };

  const clearFinished = () => {
    writeJobs((prev) => prev.filter((j) => j.status !== 'done' && j.status !== 'error'));
  };

  const pending = jobs.filter((j) => j.status === 'pending').length;
  const running = jobs.some((j) => j.status === 'running');
  const hasFinished = jobs.some((j) => j.status === 'done' || j.status === 'error');
  const summary = running
    ? `Loading… ${pending ? `(+${pending} queued)` : ''}`
    : pending > 0
      ? `${pending} queued`
      : 'Load feeds';

  return (
    <div className="upload-menu" ref={menuRef}>
      <button
        className="primary"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {summary} ▾
      </button>
      {open && (
        <div
          className="upload-menu-popover"
          role="menu"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          <div className="upload-menu-row">
            <button className="primary" onClick={onPickFiles}>
              Add feeds…
            </button>
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {running ? 'Processing' : jobs.length === 0 ? 'Idle' : `${jobs.length} total`}
            </span>
          </div>
          <div className="upload-menu-hint muted">
            Pick multiple GTFS .zip files or drop them here — they'll load one after another.
          </div>
          {ingesting && running && (
            <div className="upload-menu-progress muted">
              <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
              <span className="upload-menu-progress-text">{ingesting.progress}</span>
            </div>
          )}
          {jobs.length === 0 ? (
            <div className="upload-menu-empty muted">No uploads yet.</div>
          ) : (
            <ul className="upload-menu-list">
              {jobs.map((j) => (
                <li key={j.id} className={`upload-job upload-job--${j.status}`}>
                  <span className="upload-job-status" aria-hidden>
                    {j.status === 'pending' && '•'}
                    {j.status === 'running' && (
                      <span
                        className="spinner"
                        style={{ width: 10, height: 10, borderWidth: 2 }}
                      />
                    )}
                    {j.status === 'done' && '✓'}
                    {j.status === 'error' && '!'}
                  </span>
                  <span className="upload-job-name" title={j.file.name}>
                    {j.file.name}
                  </span>
                  <span className="upload-job-meta muted">
                    {j.status === 'error' ? j.error : formatBytes(j.file.size)}
                  </span>
                  {(j.status === 'pending' || j.status === 'done' || j.status === 'error') && (
                    <button
                      className="upload-job-remove"
                      onClick={() => removeJob(j.id)}
                      title={j.status === 'pending' ? 'Remove from queue' : 'Dismiss'}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {hasFinished && (
            <div className="upload-menu-row">
              <button onClick={clearFinished}>Clear finished</button>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            multiple
            style={{ display: 'none' }}
            onChange={onFiles}
          />
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
