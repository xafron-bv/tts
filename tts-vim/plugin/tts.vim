if exists('g:loaded_tts') | finish | endif
let g:loaded_tts = 1

" Highlight group
highlight default TTSCurrentSentence guibg=#2d3b55 ctermbg=237

" Commands
command! -range=% TTSPlay call tts#Play(<line1>, <line2>)
command! TTSStop  call tts#Stop()
command! TTSPause call tts#Pause()
command! TTSNext  call tts#Next()
command! TTSPrev  call tts#Prev()

" Default mappings (override with g:tts_no_mappings = 1)
if !get(g:, 'tts_no_mappings', 0)
  nnoremap <silent> <Leader>tt :TTSPlay<CR>
  vnoremap <silent> <Leader>tt :TTSPlay<CR>
  nnoremap <silent> <Leader>tg :.,$TTSPlay<CR>
  nnoremap <silent> <Leader>tq :TTSStop<CR>
  nnoremap <silent> <Leader>tp :TTSPause<CR>
  nnoremap <silent> <Leader>tj :TTSNext<CR>
  nnoremap <silent> <Leader>tk :TTSPrev<CR>
  nnoremap <silent> <Leader>t] :call tts#Speed(1)<CR>
  nnoremap <silent> <Leader>t[ :call tts#Speed(-1)<CR>
endif

" Clean up on exit
augroup tts_cleanup
  autocmd!
  autocmd VimLeavePre * call tts#Shutdown()
augroup END
