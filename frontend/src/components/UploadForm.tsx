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
    file: File
    arrayBuffer: ArrayBuffer
    retentionMinutes: number
    fileName: string
    mimeType: string
  }) => void
  disabled?: boolean
  maxBytes?: number
}

const UploadForm: React.FC<UploadFormProps> = ({ onReady, disabled, maxBytes }) => {
  const [hostingMinutes, setHostingMinutes] = useState<number>(180) // default 3 hours
  const [file, setFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    if (!file) {
      setUploadProgress(0)
      setError('')
    }
  }, [file])

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    setError('')

    if (!selected) {
      setFile(null)
      return
    }

    if (typeof maxBytes === 'number' && selected.size > maxBytes) {
      setFile(null)
      setError(`File exceeds limit of ${(maxBytes / (1024 * 1024)).toFixed(1)} MB`)
      return
    }

    setFile(selected)
  }

  const readFile = (f: File): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.onabort = () => reject(new Error('File read aborted'))
      reader.onprogress = (evt) => {
        if (evt.lengthComputable) {
          const pct = (evt.loaded / evt.total) * 100
          setUploadProgress(pct)
        } else {
          setUploadProgress(0)
        }
      }
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) resolve(reader.result)
        else reject(new Error('Unexpected reader result'))
      }
      reader.readAsArrayBuffer(f)
    })

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
    } catch (err: any) {
      setError(err?.message || 'Failed to prepare file')
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
          <Typography color="textSecondary">
            The file will be encrypted with the thread key and uploaded via UHRP in your send flow.
          </Typography>
        </Box>

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

        <Box>
          <Button variant="outlined" component="label" disabled={disabled}>
            Choose File
            <input type="file" hidden onChange={handleFileChange} />
          </Button>

          {file && (
            <Typography sx={{ mt: 1 }} variant="body2">
              Selected: <b>{file.name}</b> ({(file.size / (1024 * 1024)).toFixed(2)} MB)
            </Typography>
          )}
        </Box>

        {loading && (
          <LinearProgress
            variant={uploadProgress ? 'determinate' : 'indeterminate'}
            value={uploadProgress || undefined}
          />
        )}

        {error && <Alert severity="error">{error}</Alert>}

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
