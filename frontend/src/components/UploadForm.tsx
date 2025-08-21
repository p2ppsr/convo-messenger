/**
 * UploadForm.tsx
 *
 * This form does ONLY local prep:
 * - I let the user pick a file and a retention window.
 * - I read the file into an ArrayBuffer (showing progress while reading).
 * - I hand the raw bytes + metadata back to the parent via onReady(...).
 *
 * IMPORTANT: I’m NOT uploading or encrypting here. The parent decides how to:
 * - encrypt (CurvePoint by default in our send flow; legacy per-thread key if needed)
 * - upload to UHRP (and with what retention policy)
 */

import React, { useState, ChangeEvent, FormEvent, useEffect } from 'react'
import {
  Button,
  LinearProgress,
  Select,
  MenuItem,
  Typography,
  FormControl,
  InputLabel,
  Alert,
  Stack,
  Box
} from '@mui/material'
import { CloudUpload } from '@mui/icons-material'

type UploadFormProps = {
  onReady: (args: {
    file: File                   // original File object (for filename, type, etc.)
    arrayBuffer: ArrayBuffer     // raw file bytes (parent will encrypt + upload)
    retentionMinutes: number     // how long the overlay host should keep it
    fileName: string             // convenience copy of file.name
    mimeType: string             // MIME type from the File (or fallback)
  }) => void
  disabled?: boolean             // parent can disable the entire control flow
  maxBytes?: number              // optional file size cap; I reject if exceeded
}

const UploadForm: React.FC<UploadFormProps> = ({ onReady, disabled, maxBytes }) => {
  /** Default retention = 3 hours. Parent can override in the send step if needed. */
  const [hostingMinutes, setHostingMinutes] = useState<number>(180)

  /** Currently selected file (or null if none). */
  const [file, setFile] = useState<File | null>(null)

  /**
   * Local read progress while I stream the file into memory with FileReader.
   * Note: This is NOT upload progress; I purposely read before upload to encrypt first.
   */
  const [uploadProgress, setUploadProgress] = useState<number>(0)

  /** I flip this while I’m reading the file to block re-clicks. */
  const [loading, setLoading] = useState<boolean>(false)

  /** Any validation/read errors get surfaced here. */
  const [error, setError] = useState<string>('')

  /**
   * Whenever the selected file is cleared or changed, I reset progress and errors
   * so old UI state doesn’t hang around.
   */
  useEffect(() => {
    if (!file) {
      setUploadProgress(0)
      setError('')
    }
  }, [file])

  /**
   * Handle <input type="file"> changes.
   * - I enforce an optional maxBytes cap if provided by parent.
   * - I store the File so I can read it later (on submit).
   */
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] || null
    setError('')

    if (!selected) {
      setFile(null)
      return
    }

    // Enforce size limit if parent specified maxBytes
    if (typeof maxBytes === 'number' && selected.size > maxBytes) {
      setFile(null)
      setError(`File exceeds limit of ${(maxBytes / (1024 * 1024)).toFixed(1)} MB`)
      return
    }

    setFile(selected)
  }

  /**
   * Read the file into memory as an ArrayBuffer.
   * I surface progress as the browser reads the file.
   * This is synchronous with the UI (no worker), but fine for typical chat attachments.
   */
  const readFile = (f: File): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()

      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.onabort  = () => reject(new Error('File read aborted'))

      reader.onprogress = (evt) => {
        if (evt.lengthComputable) {
          const pct = (evt.loaded / evt.total) * 100
          setUploadProgress(pct)
        } else {
          // Some browsers don’t provide a computable length; show indeterminate.
          setUploadProgress(0)
        }
      }

      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result)
        } else {
          reject(new Error('Unexpected reader result'))
        }
      }

      // Kick off the read
      reader.readAsArrayBuffer(f)
    })

  /**
   * On submit:
   * - I read the file fully into memory.
   * - I pass the raw buffer + metadata up via onReady so the parent can
   *   encrypt and perform the actual UHRP upload.
   */
  const handlePrepare = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) return

    setLoading(true)
    setError('')
    try {
      const buf = await readFile(file)
      onReady({
        file,
        arrayBuffer: buf,
        retentionMinutes: hostingMinutes,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream'
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to prepare file'
      setError(msg)
    } finally {
      setLoading(false)
      setUploadProgress(0)
    }
  }

  return (
    <form onSubmit={handlePrepare}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h5">Attach a File</Typography>
          <Typography color="text.secondary">
            The file will be end-to-end encrypted in the send step
            (CurvePoint by default; legacy per-thread key if needed), then uploaded via UHRP.
          </Typography>
        </Box>

        {/* Retention picker for the overlay host. I forward the minutes up via onReady. */}
        <FormControl fullWidth>
          <InputLabel id="duration-label">Retention</InputLabel>
          <Select
            labelId="duration-label"
            label="Retention"
            value={hostingMinutes}
            onChange={(e) => setHostingMinutes(Number(e.target.value))}
          >
            <MenuItem value={180}>3 Hours</MenuItem>
            <MenuItem value={1440}>1 Day</MenuItem>
            <MenuItem value={1440 * 7}>1 Week</MenuItem>
            <MenuItem value={1440 * 30}>1 Month</MenuItem>
            <MenuItem value={1440 * 90}>3 Months</MenuItem>
            <MenuItem value={1440 * 180}>6 Months</MenuItem>
            <MenuItem value={525600}>1 Year</MenuItem>
            <MenuItem value={525600 * 2}>2 Years</MenuItem>
            <MenuItem value={525600 * 5}>5 Years</MenuItem>
            <MenuItem value={525600 * 10}>10 Years</MenuItem>
            <MenuItem value={525600 * 20}>20 Years</MenuItem>
            <MenuItem value={525600 * 30}>30 Years</MenuItem>
            <MenuItem value={525600 * 50}>50 Years</MenuItem>
            <MenuItem value={525600 * 100}>100 Years</MenuItem>
          </Select>
        </FormControl>

        {/* File chooser (disabled while reading or if parent disables the form). */}
        <Box>
          <Button variant="outlined" component="label" disabled={disabled || loading}>
            Choose File
            <input type="file" hidden onChange={handleFileChange} />
          </Button>

          {/* Friendly summary once a file is selected. */}
          {file && (
            <Typography sx={{ mt: 1 }} variant="body2">
              Selected: <b>{file.name}</b> ({(file.size / (1024 * 1024)).toFixed(2)} MB)
            </Typography>
          )}
        </Box>

        {/* Local read progress (NOT network). If length isn’t computable, I switch to indeterminate. */}
        {loading && (
          <LinearProgress
            variant={uploadProgress ? 'determinate' : 'indeterminate'}
            value={uploadProgress || undefined}
          />
        )}

        {/* Any validation/read errors appear here. */}
        {error && <Alert severity="error">{error}</Alert>}

        {/* I only enable the button when I have a file, no errors, not disabled, and not in-flight. */}
        <Box>
          <Button
            variant="contained"
            color="primary"
            size="large"
            type="submit"
            disabled={!file || !!error || disabled || loading}
            startIcon={<CloudUpload />}
          >
            Use File
          </Button>
        </Box>
      </Stack>
    </form>
  )
}

export default UploadForm
