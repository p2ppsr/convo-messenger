/**
 * DownloadForm.tsx
 *
 * Lets me fetch a UHRP object (by hash or full URL) from a chosen overlay host.
 * If I toggle "Attempt decrypt", I try:
 *   1) CurvePoint decryption first (uses my wallet identity + [1, 'ConvoAttachment']),
 *   2) then optionally a legacy per-thread AES-256-GCM key (base64) if provided.
 * Whatever plaintext I end up with gets saved as a file via a Blob URL.
 */

import React, { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Button,
  LinearProgress,
  TextField,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Stack,
  Box,
  FormControlLabel,
  Switch
} from '@mui/material'
import type { SelectChangeEvent } from '@mui/material'
import { CloudDownload } from '@mui/icons-material'

import constants from '../utils/constants'
import { WalletClient, SymmetricKey, Utils } from '@bsv/sdk'
import { getCurvePoint } from '../utils/curvePointSingleton'

type DownloadFormProps = {}

/**
 * I make sure Blob gets a **plain ArrayBuffer**, not a SharedArrayBuffer-backed view.
 * TS can complain otherwise, and some browsers are picky about SAB here.
 */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const bufLike = u8.buffer
  // Reuse the underlying buffer only if this view spans it completely
  if (
    bufLike instanceof ArrayBuffer &&
    u8.byteOffset === 0 &&
    u8.byteLength === bufLike.byteLength
  ) {
    return bufLike
  }
  // Otherwise copy into a fresh ArrayBuffer
  const out = new ArrayBuffer(u8.byteLength)
  new Uint8Array(out).set(u8)
  return out
}

const DownloadForm: React.FC<DownloadFormProps> = () => {
  /**
   * Overlay host choices:
   * - Prefer new fields if present in `constants`
   * - Fallback to older names for compatibility
   * - Final fallback to `constants.uhrpGateway` or a placeholder
   */
  const overlayChoices: string[] = useMemo(() => {
    const newer = (constants as any).OVERLAY_CHOICES as string[] | undefined
    if (newer?.length) return newer
    const legacy = (constants as any).confederacyURLs as string[] | undefined
    if (legacy?.length) return legacy
    return [constants.uhrpGateway ?? 'https://your-overlay.example.com']
  }, [])

  /** Default selected overlay host */
  const defaultOverlay = useMemo(() => {
    const newer = (constants as any).OVERLAY_HOST as string | undefined
    if (newer) return newer
    const legacy = (constants as any).confederacyURL as string | undefined
    return legacy ?? overlayChoices[0]
  }, [overlayChoices])

  // ------------ UI state ------------
  const [overlayServiceURL, setOverlayServiceURL] = useState<string>(defaultOverlay)
  const [downloadHash, setDownloadHash] = useState<string>('') // can be UHRP hash or full URL
  const [loading, setLoading] = useState<boolean>(false)
  const [inputsValid, setInputsValid] = useState<boolean>(false)
  const [openDialog, setOpenDialog] = useState<boolean>(false) // add custom host
  const [newOption, setNewOption] = useState<string>('')
  const [errorMsg, setErrorMsg] = useState<string>('')

  // Decrypt options
  const [attemptDecrypt, setAttemptDecrypt] = useState<boolean>(true)
  const [legacyKeyB64, setLegacyKeyB64] = useState<string>('') // optional: base64 32-byte legacy key

  // Keep the "Download" button disabled until both inputs look sane
  useEffect(() => {
    setInputsValid(overlayServiceURL.trim() !== '' && downloadHash.trim() !== '')
  }, [overlayServiceURL, downloadHash])

  // Dropdown change: either pick a value or open the “add custom host” dialog
  const handleSelectChange = (event: SelectChangeEvent<string>) => {
    const selectedValue = event.target.value
    if (selectedValue === 'add-new-option') setOpenDialog(true)
    else setOverlayServiceURL(selectedValue)
  }

  const handleCloseDialog = () => setOpenDialog(false)
  const handleAddOption = () => {
    const v = newOption.trim()
    if (!v) return
    setOverlayServiceURL(v)
    setNewOption('')
    setOpenDialog(false)
  }

  /** Build a full URL from either a UHRP hash or a direct https URL */
  const resolveURL = (hashOrUrl: string): string => {
    if (/^https?:\/\//i.test(hashOrUrl)) return hashOrUrl
    const base = overlayServiceURL.replace(/\/+$/, '')
    return `${base}/${hashOrUrl.replace(/^\/+/, '')}`
  }

  /**
   * Try CurvePoint decrypt first.
   * - Uses my wallet identity (via WalletClient('auto', constants.walletHost))
   * - ProtocolID: [1, 'ConvoAttachment']
   * - keyID: '1'
   * Returns plaintext bytes on success or null on failure.
   */
  const tryCurvePointDecrypt = async (bytes: Uint8Array): Promise<Uint8Array | null> => {
    try {
      const wallet = new WalletClient('auto', constants.walletHost)
      const curve = getCurvePoint(wallet)
      const dec = await curve.decrypt(Array.from(bytes), [1, 'ConvoAttachment'], '1')
      return new Uint8Array(dec)
    } catch {
      return null
    }
  }

  /**
   * Fallback: try legacy AES-256-GCM with a per-thread symmetric key (base64).
   * The key must decode to exactly 32 bytes or I skip it.
   */
  const tryLegacySymmetricDecrypt = (bytes: Uint8Array, keyB64: string): Uint8Array | null => {
    try {
      const raw = Utils.toArray(keyB64, 'base64') as number[]
      if (raw.length !== 32) return null
      const sym = new SymmetricKey(raw)
      const dec = sym.decrypt(Array.from(bytes)) as number[]
      return new Uint8Array(dec)
    } catch {
      return null
    }
  }

  /**
   * Main submit handler:
   *  - Resolve the URL
   *  - Fetch bytes
   *  - Optionally attempt to decrypt (CurvePoint first, then legacy key)
   *  - Save the (possibly decrypted) data via a Blob download
   */
  const handleDownload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setErrorMsg('')
    setLoading(true)

    try {
      // 1) Build the URL & fetch the raw bytes
      const url = resolveURL(downloadHash)
      const resp = await fetch(url, { method: 'GET' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)

      const ab = await resp.arrayBuffer()
      // Use a plain Uint8Array so I don’t carry around SAB typing
      let data: Uint8Array = new Uint8Array(ab)

      // 2) Decrypt attempts (optional)
      if (attemptDecrypt) {
        // A) CurvePoint first
        const cp = await tryCurvePointDecrypt(data)
        if (cp) {
          data = new Uint8Array(cp) // clone to ensure clean ArrayBuffer backing
        } else if (legacyKeyB64.trim()) {
          // B) Legacy per-thread symmetric key (if provided)
          const legacy = tryLegacySymmetricDecrypt(data, legacyKeyB64.trim())
          if (legacy) data = new Uint8Array(legacy)
        }
      }

      // 3) Create a Blob and trigger a download
      // If we decrypted, server content-type likely isn’t valid for the plaintext,
      // so I just default to application/octet-stream for safety.
      const mime =
        attemptDecrypt
          ? 'application/octet-stream'
          : resp.headers.get('content-type') || 'application/octet-stream'

      const blob = new Blob([toArrayBuffer(data)], { type: mime })
      const objectURL = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = objectURL
      a.download = url.split('/').pop() || 'download'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objectURL)
    } catch (err) {
      console.error('[DownloadForm] download error:', err)
      setErrorMsg('Download failed. Please verify the UHRP hash/URL and overlay host.')
    } finally {
      setLoading(false)
    }
  }

  /** I show a simple inline preview only for raw (non-encrypted) image URLs */
  const previewURL = useMemo(
    () => (downloadHash.trim() ? resolveURL(downloadHash.trim()) : ''),
    [downloadHash, overlayServiceURL]
  )

  return (
    <>
      <form onSubmit={handleDownload}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h4">Download</Typography>
            <Typography color="textSecondary">
              Fetch any UHRP object from your overlay host. Optionally try to decrypt Convo attachments.
            </Typography>
            {errorMsg && (
              <Box mt={2}>
                <Alert severity="error">{errorMsg}</Alert>
              </Box>
            )}
          </Box>

          {/* Overlay host picker (supports adding a custom host inline) */}
          <FormControl fullWidth variant="outlined">
            <InputLabel>Overlay Host</InputLabel>
            <Select
              value={overlayServiceURL}
              onChange={handleSelectChange}
              label="Overlay Host"
            >
              {overlayChoices.map((url, index) => (
                <MenuItem key={index} value={url}>
                  {url}
                </MenuItem>
              ))}
              <MenuItem value="add-new-option">+ Add Custom Host</MenuItem>
            </Select>
          </FormControl>

          {/* The thing I want to download: either a UHRP hash or full https URL */}
          <TextField
            fullWidth
            variant="outlined"
            label="UHRP Hash or Full URL"
            value={downloadHash}
            onChange={(e) => setDownloadHash(e.target.value)}
          />

          {/* Decrypt toggle + optional legacy key input */}
          <FormControlLabel
            control={
              <Switch
                checked={attemptDecrypt}
                onChange={(e) => setAttemptDecrypt(e.target.checked)}
              />
            }
            label="Attempt decrypt (CurvePoint; fallback to legacy key)"
          />

          {attemptDecrypt && (
            <TextField
              fullWidth
              variant="outlined"
              label="Legacy thread key (base64, optional)"
              placeholder="Paste 32-byte key (base64) if needed for legacy attachments"
              value={legacyKeyB64}
              onChange={(e) => setLegacyKeyB64(e.target.value)}
            />
          )}

          {/* Add custom overlay host dialog */}
          <Dialog open={openDialog} onClose={handleCloseDialog}>
            <DialogTitle>Add a Custom Overlay Host</DialogTitle>
            <DialogContent>
              <TextField
                autoFocus
                margin="dense"
                label="https://your-overlay.example.com"
                type="text"
                fullWidth
                value={newOption}
                onChange={(e) => setNewOption(e.target.value)}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={handleCloseDialog}>Cancel</Button>
              <Button onClick={handleAddOption}>Add</Button>
            </DialogActions>
          </Dialog>

          {/* Submit */}
          <Box>
            <Button
              variant="contained"
              color="primary"
              size="large"
              type="submit"
              disabled={loading || !inputsValid}
              startIcon={<CloudDownload />}
            >
              Download
            </Button>
          </Box>

          {loading && <LinearProgress />}

          {/* Very basic, raw-only image preview (won’t show encrypted assets) */}
          {previewURL && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Preview (if image &amp; not encrypted):
              </Typography>
              <img
                src={previewURL}
                alt="Preview"
                style={{ maxWidth: '100%', borderRadius: 8 }}
                onError={() => {
                  /* ignore preview errors */
                }}
              />
            </Box>
          )}
        </Stack>
      </form>
    </>
  )
}

export default DownloadForm
