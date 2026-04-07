import { useCallback, useEffect, useId, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { buildImageFilter, getCroppedJpegBlob, rotate90Clockwise, rotate90CounterClockwise } from "../lib/imageEdit.js";

type Props = {
  imageUrl: string;
  onClose: () => void;
  onSave: (file: File) => void;
};

export function DraftPhotoEditorModal({ imageUrl, onClose, onSave }: Props) {
  const titleId = useId();
  const [workingSrc, setWorkingSrc] = useState(imageUrl);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [brightness, setBrightness] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [saturate, setSaturate] = useState(1);
  const [hueRotate, setHueRotate] = useState(0);

  useEffect(() => {
    return () => {
      if (workingSrc.startsWith("blob:")) {
        URL.revokeObjectURL(workingSrc);
      }
    };
  }, [workingSrc]);

  const onCropComplete = useCallback((_a: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  async function handleRotateCw() {
    setBusy(true);
    try {
      const next = await rotate90Clockwise(workingSrc);
      setWorkingSrc(next);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
    } finally {
      setBusy(false);
    }
  }

  async function handleRotateCcw() {
    setBusy(true);
    try {
      const next = await rotate90CounterClockwise(workingSrc);
      setWorkingSrc(next);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!croppedAreaPixels) return;
    setBusy(true);
    try {
      const filter = buildImageFilter({ brightness, contrast, saturate, hueRotate });
      const blob = await getCroppedJpegBlob(workingSrc, croppedAreaPixels, filter);
      const file = new File([blob], `edited-${Date.now()}.jpg`, { type: "image/jpeg" });
      onSave(file);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: 560,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          position: "relative",
        }}
      >
        <h2 id={titleId} style={{ marginTop: 0 }}>
          Edit photo
        </h2>
        <p style={{ fontSize: "0.85rem", color: "#64748b", marginTop: 0 }}>
          Drag to reframe, scroll to zoom. Rotation is in 90° steps. Sliders adjust color before crop.
        </p>
        <div style={{ position: "relative", width: "100%", height: 280, background: "#0f172a" }}>
          <Cropper
            image={workingSrc}
            crop={crop}
            zoom={zoom}
            rotation={0}
            aspect={4 / 3}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            objectFit="contain"
          />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem" }}>
          <button type="button" disabled={busy} onClick={() => void handleRotateCcw()}>
            Rotate left
          </button>
          <button type="button" disabled={busy} onClick={() => void handleRotateCw()}>
            Rotate right
          </button>
        </div>
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem" }}>
          <label style={{ fontSize: "0.85rem" }}>
            Brightness ({brightness.toFixed(2)})
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.02}
              value={brightness}
              onChange={(e) => setBrightness(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ fontSize: "0.85rem" }}>
            Contrast ({contrast.toFixed(2)})
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.02}
              value={contrast}
              onChange={(e) => setContrast(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ fontSize: "0.85rem" }}>
            Saturation ({saturate.toFixed(2)})
            <input
              type="range"
              min={0}
              max={2}
              step={0.02}
              value={saturate}
              onChange={(e) => setSaturate(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ fontSize: "0.85rem" }}>
            Hue rotate ({hueRotate}°)
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={hueRotate}
              onChange={(e) => setHueRotate(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "1rem" }}>
          <button type="button" className="primary" disabled={busy || !croppedAreaPixels} onClick={() => void handleApply()}>
            {busy ? "Working…" : "Save edited image"}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
