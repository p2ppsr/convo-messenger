import React, { FormEvent, useState, useEffect, useRef, useContext } from 'react'
import { Button, LinearProgress, Grid, TextField, Typography, FormControl,
  InputLabel, Select, MenuItem, Dialog, DialogTitle, DialogContent, DialogActions,
  DialogContentText, Autocomplete, Box,
} from '@mui/material'
import { CloudDownload } from '@mui/icons-material'
import { download } from 'nanoseek'
import constants from '../utils/constants'
import { SelectChangeEvent } from '@mui/material'
import useAsyncEffect from 'use-async-effect'
import { discoverByAttributes } from '@babbage/sdk-ts'
import { Identity, parseIdentity, TrustLookupResult } from 'identinator'
import { Img } from 'uhrp-react'
import { addChat } from '../utils/loadSettings'
import { Controller, useForm } from 'react-hook-form'
import { chatIdListContext } from '../App'

interface UserOption {
  info: Identity
  key: number
} 

interface FormFields {
  selectedUsers: Array<UserOption>
}

export default function NewConversationDialog({open, close}: {open:boolean, close:any}) {

  const internalChatIdListContext = useContext(chatIdListContext)
  if (!internalChatIdListContext) {
    throw new Error('chatIdListContext must be used within a Provider')
  }

  const [searchTerm, setSearchTerm] = useState<string>('')
  const [searchResults, setSearchResults] = useState<UserOption[]>([])
  const [newChatIdentity, setNewChatIdentity] = useState<UserOption | null>(null)
  const [inputValue, setInputValue] = useState<string>('')
  const [chatIdList, setChatIdList] = internalChatIdListContext
  
  // const [users, setUsers] = useState<UserOption[]>([])

  const initFormFieldValues = {
    selectedUsers: []
  }

  const methods = useForm<FormFields>({
    defaultValues: initFormFieldValues
  })

  const onSubmit = async (data: FormFields) => {
    // setLoading(true)
    try {

      data.selectedUsers.forEach((user) => {
        addChat(user.info.identityKey)
        setChatIdList([...chatIdList, user.info.identityKey])
      })
      
    } catch (error) {
      console.error('An error occurred while creating the chat: ', error)
    } finally {
      // setLoading(false)
      close()
    }
  }

  useAsyncEffect(async () => {
    const results = await discoverByAttributes({
      attributes: {
        any: searchTerm
      },
      description: 'Searching for chat participants'
    })

    const lookupResults = results as TrustLookupResult[]

    setSearchResults(lookupResults.map((result, index) => ({
      info: parseIdentity(result),
      key: index
    } as UserOption)))

  }, [searchTerm]) 

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        PaperProps={{
          component: 'form',
          onSubmit: methods.handleSubmit(onSubmit)
        }}
      >

        <DialogTitle>New Conversation</DialogTitle>

        <DialogContent>

          <DialogContentText>Search below for users to add by any attribute.</DialogContentText>

          <DialogContentText>Chats between you and one other person are encrypted. Group chats are not encrypted.</DialogContentText>

          <DialogContentText>Group chats are not encrypted.</DialogContentText>

          <Controller
            name={'selectedUsers'}
            control={methods.control}
            render={({ field: { onChange, value } }) => (
              <Autocomplete
                multiple
                id='users-selection'
                options={searchResults as UserOption[]}
                getOptionLabel={(searchResult: UserOption) => searchResult.info.name}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    variant='standard'
                    label='Select Users'
                    placeholder='Enter a name to search'
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                )}
                renderOption={(props, option) => {
                  const { key, ...optionProps } = props
                  return (
                    <Box
                      {...optionProps}
                      key={option.key}
                      component='li'
                      >
                        {/* TODO not sure how best to set image size here */}
                        <Img src={option.info.avatarURL} width={'30px'} confederacyHost={'https://confederacy.babbage.systems'} />
                        <Typography sx={{marginLeft: '10px'}}>{option.info.name}</Typography>
                      </Box>
                  )
                }}
                onChange={(_, data) => {
                  onChange(data)
                  return data
                }}
                defaultValue={initFormFieldValues.selectedUsers}
              />
            )}
          />

        </DialogContent>

        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button type='submit'>Create</Button>
        </DialogActions>

      </Dialog>
    </>
  )
}
