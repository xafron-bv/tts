let s:job = v:null
let s:channel = v:null
let s:nvim_job = 0
let s:match_ids = []
let s:total = 0
let s:current_idx = -1
let s:playing = 0
let s:paused = 0
let s:speed = 1.5

let s:plugin_dir = expand('<sfile>:p:h:h')
let s:server_script = s:plugin_dir . '/tts-server.py'

" ── Public API ────────────────────────────────────────────────

function! tts#Play(line1, line2) abort
  let lines = getline(a:line1, a:line2)
  let text = join(lines, "\n")
  if empty(trim(text))
    echohl WarningMsg | echo 'TTS: no text to read' | echohl None
    return
  endif
  call s:EnsureServer()
  call s:Send(json_encode({'cmd': 'play', 'text': text}))
endfunction

function! tts#Stop() abort
  if !s:playing | return | endif
  call s:Send(json_encode({'cmd': 'stop'}))
endfunction

function! tts#Pause() abort
  if !s:playing | return | endif
  if s:paused
    call s:Send(json_encode({'cmd': 'resume'}))
  else
    call s:Send(json_encode({'cmd': 'pause'}))
  endif
endfunction

function! tts#Next() abort
  if !s:playing | return | endif
  call s:Send(json_encode({'cmd': 'next'}))
endfunction

function! tts#Prev() abort
  if !s:playing | return | endif
  call s:Send(json_encode({'cmd': 'prev'}))
endfunction

function! tts#Speed(delta) abort
  let speeds = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]
  let idx = index(speeds, s:speed)
  if idx < 0 | let idx = 2 | endif
  let idx = max([0, min([len(speeds) - 1, idx + a:delta])])
  let s:speed = speeds[idx]
  call s:Send(json_encode({'cmd': 'speed', 'value': s:speed}))
endfunction

function! tts#Shutdown() abort
  call s:ClearHighlight()
  if has('nvim')
    if s:nvim_job > 0
      call chansend(s:nvim_job, json_encode({'cmd': 'quit'}) . "\n")
      call jobstop(s:nvim_job)
      let s:nvim_job = 0
    endif
  else
    if s:job != v:null && job_status(s:job) ==# 'run'
      call s:Send(json_encode({'cmd': 'quit'}))
      call job_stop(s:job)
      let s:job = v:null
      let s:channel = v:null
    endif
  endif
  let s:playing = 0
endfunction

" ── Server management ─────────────────────────────────────────

function! s:EnsureServer() abort
  if has('nvim')
    if s:nvim_job > 0 | return | endif
    let s:nvim_job = jobstart(['python3', s:server_script], {
          \ 'on_stdout': function('s:OnStdoutNvim'),
          \ 'on_stderr': function('s:OnStderrNvim'),
          \ 'on_exit': function('s:OnExitNvim'),
          \ })
  else
    if s:job != v:null && job_status(s:job) ==# 'run' | return | endif
    let s:job = job_start(['python3', s:server_script], {
          \ 'out_cb': function('s:OnStdout'),
          \ 'err_cb': function('s:OnStderr'),
          \ 'exit_cb': function('s:OnExit'),
          \ 'out_mode': 'nl',
          \ })
    let s:channel = job_getchannel(s:job)
  endif
endfunction

function! s:Send(msg) abort
  if has('nvim')
    if s:nvim_job > 0
      call chansend(s:nvim_job, a:msg . "\n")
    endif
  else
    if s:channel != v:null
      call ch_sendraw(s:channel, a:msg . "\n")
    endif
  endif
endfunction

" ── Callbacks ─────────────────────────────────────────────────

function! s:OnStdout(channel, msg) abort
  call s:HandleEvent(a:msg)
endfunction

function! s:OnStdoutNvim(job_id, data, event) abort
  for line in a:data
    if !empty(line)
      call s:HandleEvent(line)
    endif
  endfor
endfunction

function! s:OnStderr(channel, msg) abort
endfunction

function! s:OnStderrNvim(job_id, data, event) abort
endfunction

function! s:OnExit(job, status) abort
  let s:job = v:null
  let s:channel = v:null
  let s:playing = 0
  call s:ClearHighlight()
endfunction

function! s:OnExitNvim(job_id, code, event) abort
  let s:nvim_job = 0
  let s:playing = 0
  call s:ClearHighlight()
endfunction

" ── Event handling ────────────────────────────────────────────

function! s:HandleEvent(raw) abort
  try
    let data = json_decode(a:raw)
  catch
    return
  endtry

  let ev = get(data, 'event', '')

  if ev ==# 'sentences'
    let s:total = data.total
    let s:playing = 1
    let s:paused = 0

  elseif ev ==# 'playing'
    let s:current_idx = data.index
    let s:playing = 1
    let s:paused = 0
    call s:HighlightSentence(data.text)
    call s:UpdateStatus()

  elseif ev ==# 'paused'
    let s:paused = 1
    call s:UpdateStatus()

  elseif ev ==# 'resumed'
    let s:paused = 0
    call s:UpdateStatus()

  elseif ev ==# 'speed'
    let s:speed = data.value
    call s:UpdateStatus()

  elseif ev ==# 'finished' || ev ==# 'stopped'
    let s:playing = 0
    let s:paused = 0
    call s:ClearHighlight()
    redraw | echo ''

  elseif ev ==# 'error'
    echohl ErrorMsg | echomsg 'TTS: ' . data.message | echohl None

  endif
endfunction

" ── Highlighting ──────────────────────────────────────────────

function! s:HighlightSentence(text) abort
  call s:ClearHighlight()

  let save_view = winsaveview()

  " Build a very-nomagic pattern; replace whitespace runs with flexible match
  let escaped = escape(a:text, '\/')
  " Truncate long sentences for pattern matching
  if len(escaped) > 200
    let escaped = escaped[:199]
  endif
  let pattern = '\V' . substitute(escaped, '\_s\+', '\\_s\\+', 'g')
  " Also handle simple spaces
  let pattern = substitute(pattern, ' ', '\\_s\\+', 'g')

  call cursor(1, 1)
  let found = search(pattern, 'cW')
  if found
    let start_line = line('.')
    call search(pattern, 'ceW')
    let end_line = line('.')

    for lnum in range(start_line, end_line)
      call add(s:match_ids, matchaddpos('TTSCurrentSentence', [[lnum]]))
    endfor

    call cursor(start_line, 1)
    normal! zz
  else
    call winrestview(save_view)
  endif
endfunction

function! s:ClearHighlight() abort
  for id in s:match_ids
    try | call matchdelete(id) | catch | endtry
  endfor
  let s:match_ids = []
endfunction

" ── Status ────────────────────────────────────────────────────

function! s:UpdateStatus() abort
  redraw
  let icon = s:paused ? '⏸' : '▶'
  let msg = printf(' TTS %s [%d/%d] %sx', icon, s:current_idx + 1, s:total, string(s:speed))
  echohl ModeMsg | echon msg | echohl None
endfunction
