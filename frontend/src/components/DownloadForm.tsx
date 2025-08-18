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
  Box
} from '@mui/material'
import type { SelectChangeEvent } from '@mui/material'
import { CloudDownload } from '@mui/icons-material'
import constants from '../utils/constants'

type DownloadFormProps = {}

const DownloadForm: React.FC<DownloadFormProps> = () => {
  const overlayChoices: string[] = useMemo(() => {
    const newer = (constants as any).OVERLAY_CHOICES as string[] | undefined
    if (newer?.length) return newer
    const legacy = (constants as any).confederacyURLs as string[] | undefined
    if (legacy?.length) return legacy
    return [constants.uhrpGateway ?? 'https://your-overlay.example.com']
  }, [])

  const defaultOverlay = useMemo(() => {
    const newer = (constants as any).OVERLAY_HOST as string | undefined
    if (newer) return newer
    const legacy = (constants as any).confederacyURL as string | undefined
    return legacy ?? overlayChoices[0]
  }, [overlayChoices])

  const [overlayServiceURL, setOverlayServiceURL] = useState<string>(defaultOverlay)
  const [downloadHash, setDownloadHash] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)
  const [inputsValid, setInputsValid] = useState<boolean>(false)
  const [openDialog, setOpenDialog] = useState<boolean>(false)
  const [newOption, setNewOption] = useState<string>('')
  const [errorMsg, setErrorMsg] = useState<string>('')

  useEffect(() => {
    setInputsValid(overlayServiceURL.trim() !== '' && downloadHash.trim() !== '')
  }, [overlayServiceURL, downloadHash])

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

  const resolveURL = (hashOrUrl: string): string => {
    if (/^https?:\/\//i.test(hashOrUrl)) return hashOrUrl
    const base = overlayServiceURL.replace(/\/+$/, '')
    return `${base}/${hashOrUrl.replace(/^\/+/, '')}`
  }

  const handleDownload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setErrorMsg('')
    setLoading(true)
    try {
      const url = resolveURL(downloadHash)
      const resp = await fetch(url, { method: 'GET' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
      const blob = await resp.blob()

      const a = document.createElement('a')
      const objectURL = URL.createObjectURL(blob)
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
              Fetch any UHRP object from your overlay host.
            </Typography>
            {errorMsg && (
              <Box mt={2}>
                <Alert severity="error">{errorMsg}</Alert>
              </Box>
            )}
          </Box>

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

          <TextField
            fullWidth
            variant="outlined"
            label="UHRP Hash or Full URL"
            value={downloadHash}
            onChange={(e) => setDownloadHash(e.target.value)}
          />

          {/* Dialog for adding a new host option */}
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

          {/* Simple preview for images */}
          {previewURL && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Preview (if image):
              </Typography>
              <img
                src={previewURL}
                alt="Preview"
                style={{ maxWidth: '100%', borderRadius: 8 }}
                onError={() => {
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
