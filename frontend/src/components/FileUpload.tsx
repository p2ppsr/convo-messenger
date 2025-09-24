// src/components/FileUpload.tsx
import React, { useRef } from 'react'
import { IconButton } from '@mui/material'
import AttachFileIcon from '@mui/icons-material/AttachFile'

interface FileUploadProps {
  onFileSelected: (file: File) => void
}

/**
 * FileUpload
 * - Renders a paperclip icon button
 * - Opens file picker when clicked
 * - Calls onFileSelected with the chosen File
 * - Also supports drag & drop into the button
 */
const FileUpload: React.FC<FileUploadProps> = ({ onFileSelected }) => {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleClick = () => {
    inputRef.current?.click()
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelected(e.target.files[0])
      e.target.value = '' // reset so same file can be picked again
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileSelected(e.dataTransfer.files[0])
      e.dataTransfer.clearData()
    }
  }

  return (
    <>
      <input
        type="file"
        hidden
        ref={inputRef}
        onChange={handleChange}
      />
      <IconButton
        color="primary"
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        sx={{ alignSelf: 'flex-end' }}
      >
        <AttachFileIcon />
      </IconButton>
    </>
  )
}

export default FileUpload
