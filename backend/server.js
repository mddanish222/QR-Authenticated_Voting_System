// ============================================================
//  server.js  
//  Single file: entry point + all routes + middleware + helpers
//  Run: node backend/server.js
// ============================================================

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import multer from 'multer'
import { createClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'

// ── FAILED LOGIN ATTEMPTS TRACKER ──
const failedAttempts = new Map()
const MAX_ATTEMPTS   = 5
const BLOCK_MINUTES  = 30

function isBlocked(email) {
  const key    = email.toLowerCase().trim()
  const record = failedAttempts.get(key)
  if (!record) return false
  if (record.blockedUntil && Date.now() < record.blockedUntil) {
    return Math.ceil((record.blockedUntil - Date.now()) / 60000)
  }
  if (record.blockedUntil && Date.now() >= record.blockedUntil) {
    failedAttempts.delete(key)
  }
  return false
}

function recordFailedAttempt(email) {
  const key    = email.toLowerCase().trim()
  const record = failedAttempts.get(key) || { count: 0, blockedUntil: null }
  record.count++
  if (record.count >= MAX_ATTEMPTS) {
    record.blockedUntil = Date.now() + BLOCK_MINUTES * 60 * 1000
  }
  failedAttempts.set(key, record)
  return record.count
}

function clearFailedAttempts(email) {
  failedAttempts.delete(email.toLowerCase().trim())
}

dotenv.config({ path: './backend/.env' })

// ============================================================
//  SECTION 1 — SUPABASE CLIENT (service role — server only)
// ============================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ============================================================
//  SECTION 2 — EXPRESS + MULTER SETUP
// ============================================================

const app    = express()
const upload = multer({ storage: multer.memoryStorage() })

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ── NO-CACHE FOR EVERYTHING (HTML, JS, CSS + API) ──
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  next()
})

const PORT = process.env.PORT || 4000
// ============================================================
//  SECTION 3 — AUTH MIDDLEWARE
// ============================================================

async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' })
  }

  const token = authHeader.split(' ')[1]
  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  req.adminId = user.id
  req.user    = user
  next()
}

// ============================================================
//  SECTION 4 — SHARED HELPER FUNCTIONS
// ============================================================

// Check if studentId falls within any of the given ranges
function checkRangeLogic(studentId, ranges) {
  for (const range of ranges) {
    const from = range.range_from.trim().toLowerCase()
    const to   = range.range_to.trim().toLowerCase()
    const id   = studentId.trim().toLowerCase()

    const match     = id.match(/^([a-z]*)(\d+)$/)
    const matchFrom = from.match(/^([a-z]*)(\d+)$/)
    const matchTo   = to.match(/^([a-z]*)(\d+)$/)

    if (!match || !matchFrom || !matchTo) {
      if (id >= from && id <= to) return true
      continue
    }

    const prefix     = match[1]
    const prefixFrom = matchFrom[1]
    const prefixTo   = matchTo[1]

    if (prefix !== prefixFrom || prefix !== prefixTo) continue

    const num     = parseInt(match[2])
    const numFrom = parseInt(matchFrom[2])
    const numTo   = parseInt(matchTo[2])

    if (num >= numFrom && num <= numTo) return true
  }
  return false
}

async function isInUUCMSRange(studentId, groupId) {
  const { data: ranges } = await supabase
    .from('uucms_ranges')
    .select('*')
    .eq('group_id', groupId)

  if (!ranges || ranges.length === 0) return false
  return checkRangeLogic(studentId, ranges)
}

async function isInIndividualList(studentId, groupId) {
  const { data } = await supabase
    .from('individual_students')
    .select('student_id, student_name')
    .eq('group_id', groupId)
    .eq('student_id', studentId)
    .single()

  return data || null
}

async function isInCredentials(studentId, groupId) {
  const { data } = await supabase
    .from('student_credentials')
    .select('id')
    .eq('group_id', groupId)
    .eq('student_id', studentId)
    .single()

  return !!data
}


// ============================================================
//  SECTION 4B — CONFLICT DETECTION HELPERS
// ============================================================

function timesOverlap(start1, end1, start2, end2) {
  return new Date(start1) < new Date(end2) && new Date(end1) > new Date(start2)
}

function rangesOverlap(ranges1, ranges2) {
  for (const r1 of ranges1) {
    for (const r2 of ranges2) {
      const from1 = (r1.range_from || r1.rangeFrom || '').trim().toLowerCase()
      const to1   = (r1.range_to   || r1.rangeTo   || '').trim().toLowerCase()
      const from2 = (r2.range_from || r2.rangeFrom || '').trim().toLowerCase()
      const to2   = (r2.range_to   || r2.rangeTo   || '').trim().toLowerCase()

      if (!from1 || !to1 || !from2 || !to2) continue

      const m1f = from1.match(/^([a-z]*)(\d+)$/)
      const m1t = to1.match(/^([a-z]*)(\d+)$/)
      const m2f = from2.match(/^([a-z]*)(\d+)$/)
      const m2t = to2.match(/^([a-z]*)(\d+)$/)

      if (m1f && m1t && m2f && m2t && m1f[1] === m2f[1]) {
        const nf1 = parseInt(m1f[2]), nt1 = parseInt(m1t[2])
        const nf2 = parseInt(m2f[2]), nt2 = parseInt(m2t[2])
        if (nf1 <= nt2 && nt1 >= nf2) return `${from1}–${to1}`
      } else {
        if (from1 <= to2 && to1 >= from2) return `${from1}–${to1}`
      }
    }
  }
  return null
}

function studentIdInRanges(studentId, ranges) {
  return checkRangeLogic(
    studentId,
    ranges.map(r => ({
      range_from: r.range_from || r.rangeFrom || '',
      range_to:   r.range_to   || r.rangeTo   || ''
    }))
  )
}

async function findStudentConflict(newUucms, newIndividuals, newCredentials, existingGroupId) {
  const [
    { data: exUucms },
    { data: exIndividuals },
    { data: exCredentials }
  ] = await Promise.all([
    supabase.from('uucms_ranges').select('*').eq('group_id', existingGroupId),
    supabase.from('individual_students').select('*').eq('group_id', existingGroupId),
    supabase.from('student_credentials').select('*').eq('group_id', existingGroupId)
  ])

  const existingRanges      = exUucms        || []
  const existingIndividuals = exIndividuals  || []
  const existingCredentials = exCredentials  || []

  // ── New UUCMS ranges vs existing UUCMS ranges
  if (newUucms?.length && existingRanges.length) {
    const hit = rangesOverlap(newUucms, existingRanges)
    if (hit) return `range ${hit}`
  }

  // ── New UUCMS ranges vs existing individual IDs
  if (newUucms?.length && existingIndividuals.length) {
    for (const s of existingIndividuals) {
      if (studentIdInRanges(s.student_id, newUucms)) return s.student_id
    }
  }

  // ── New UUCMS ranges vs existing exceptional IDs
  if (newUucms?.length && existingCredentials.length) {
    for (const s of existingCredentials) {
      if (studentIdInRanges(s.student_id, newUucms)) return s.student_id
    }
  }

  // ── New individual IDs vs existing UUCMS ranges
  if (newIndividuals?.length && existingRanges.length) {
    for (const s of newIndividuals) {
      const id = s.studentId || s.student_id || ''
      if (id && studentIdInRanges(id, existingRanges)) return id
    }
  }

  // ── New individual IDs vs existing individual IDs
  if (newIndividuals?.length && existingIndividuals.length) {
    const exIds = new Set(existingIndividuals.map(s => s.student_id.trim().toLowerCase()))
    for (const s of newIndividuals) {
      const id = (s.studentId || s.student_id || '').trim().toLowerCase()
      if (id && exIds.has(id)) return id
    }
  }

  // ── New individual IDs vs existing exceptional IDs
  if (newIndividuals?.length && existingCredentials.length) {
    const exIds = new Set(existingCredentials.map(s => s.student_id.trim().toLowerCase()))
    for (const s of newIndividuals) {
      const id = (s.studentId || s.student_id || '').trim().toLowerCase()
      if (id && exIds.has(id)) return id
    }
  }

  // ── New exceptional IDs vs existing UUCMS ranges
  if (newCredentials?.length && existingRanges.length) {
    for (const s of newCredentials) {
      const id = s.studentId || s.student_id || ''
      if (id && studentIdInRanges(id, existingRanges)) return id
    }
  }

  // ── New exceptional IDs vs existing individual IDs
  if (newCredentials?.length && existingIndividuals.length) {
    const exIds = new Set(existingIndividuals.map(s => s.student_id.trim().toLowerCase()))
    for (const s of newCredentials) {
      const id = (s.studentId || s.student_id || '').trim().toLowerCase()
      if (id && exIds.has(id)) return id
    }
  }

  // ── New exceptional IDs vs existing exceptional IDs
  if (newCredentials?.length && existingCredentials.length) {
    const exIds = new Set(existingCredentials.map(s => s.student_id.trim().toLowerCase()))
    for (const s of newCredentials) {
      const id = (s.studentId || s.student_id || '').trim().toLowerCase()
      if (id && exIds.has(id)) return id
    }
  }

  return null
}

// ============================================================
//  SECTION 4C — CONFLICT CHECK ENDPOINTS
// ============================================================

// ── CHECK CONFLICTS BEFORE CREATING SESSION
app.post('/api/sessions/check-conflicts', verifyToken, async (req, res) => {
  try {
    const { votingStart, votingEnd, uucmsRanges, individualStudents, credentials } = req.body

    if (!votingStart || !votingEnd) {
      return res.status(400).json({ error: 'votingStart and votingEnd are required' })
    }

    // Fetch all other sessions of same admin
    const { data: otherSessions } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('admin_id', req.adminId)

    if (!otherSessions || otherSessions.length === 0) {
      return res.json({ conflict: false })
    }

    for (const session of otherSessions) {

      // ── Check new voting window vs existing voting window
      if (timesOverlap(votingStart, votingEnd, session.voting_start, session.voting_end)) {
        const hit = await findStudentConflict(
          uucmsRanges || [],
          individualStudents || [],
          credentials || [],
          session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" is already used in another voting session during this time. Please change the time or remove the conflicting entry.`
          })
        }
      }

      // ── Check new voting window vs existing published result window
      if (
        session.is_published &&
        session.result_start &&
        session.result_end &&
        timesOverlap(votingStart, votingEnd, session.result_start, session.result_end)
      ) {
        const hit = await findStudentConflict(
          uucmsRanges || [],
          individualStudents || [],
          credentials || [],
          session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" already has results published during this time. Please change the time or remove the conflicting entry.`
          })
        }
      }
    }

    return res.json({ conflict: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── CHECK CONFLICTS BEFORE PUBLISHING RESULTS
app.post('/api/sessions/:id/check-publish-conflicts', verifyToken, async (req, res) => {
  try {
    const GROUP_ID = req.params.id
    const { resultStart, resultEnd, extraRanges } = req.body

    if (!resultStart || !resultEnd) {
      return res.status(400).json({ error: 'resultStart and resultEnd are required' })
    }

    // Verify ownership
    const { data: currentSession } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('id', GROUP_ID)
      .eq('admin_id', req.adminId)
      .single()

    if (!currentSession) {
      return res.status(403).json({ error: 'Unauthorized or session not found' })
    }

    // Fetch current session's own student lists
    const [
      { data: ownUucms },
      { data: ownIndividuals },
      { data: ownCredentials }
    ] = await Promise.all([
      supabase.from('uucms_ranges').select('*').eq('group_id', GROUP_ID),
      supabase.from('individual_students').select('*').eq('group_id', GROUP_ID),
      supabase.from('student_credentials').select('*').eq('group_id', GROUP_ID)
    ])

    // Merge extraRanges into uucms list
    const mergedUucms = [
      ...(ownUucms || []),
      ...(extraRanges || []).map(r => ({ range_from: r.rangeFrom, range_to: r.rangeTo }))
    ]

    // Fetch all OTHER sessions of same admin (exclude current session)
    const { data: otherSessions } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('admin_id', req.adminId)
      .neq('id', GROUP_ID)

    if (!otherSessions || otherSessions.length === 0) {
      return res.json({ conflict: false })
    }

    for (const session of otherSessions) {

      // ── Check new result window vs existing voting window
      if (timesOverlap(resultStart, resultEnd, session.voting_start, session.voting_end)) {
        const hit = await findStudentConflict(
          mergedUucms,
          ownIndividuals || [],
          ownCredentials || [],
          session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" is in an active voting session during this result window. Please change the result time or remove the conflicting entry.`
          })
        }
      }

      // ── Check new result window vs existing published result window
      if (
        session.is_published &&
        session.result_start &&
        session.result_end &&
        timesOverlap(resultStart, resultEnd, session.result_start, session.result_end)
      ) {
        const hit = await findStudentConflict(
          mergedUucms,
          ownIndividuals || [],
          ownCredentials || [],
          session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" already has results published during this result window. Please change the result time or remove the conflicting entry.`
          })
        }
      }
    }

    return res.json({ conflict: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── CHECK CONFLICTS BEFORE EDITING SESSION
app.post('/api/sessions/:id/check-edit-conflicts', verifyToken, async (req, res) => {
  try {
    const GROUP_ID = req.params.id
    const { votingStart, votingEnd, resultStart, resultEnd } = req.body

    if (!votingStart || !votingEnd) {
      return res.status(400).json({ error: 'votingStart and votingEnd are required' })
    }

    // Verify ownership
    const { data: currentSession } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('id', GROUP_ID)
      .eq('admin_id', req.adminId)
      .single()

    if (!currentSession) {
      return res.status(403).json({ error: 'Unauthorized or session not found' })
    }

    // Fetch this session's own student lists
    const [
      { data: ownUucms },
      { data: ownIndividuals },
      { data: ownCredentials }
    ] = await Promise.all([
      supabase.from('uucms_ranges').select('*').eq('group_id', GROUP_ID),
      supabase.from('individual_students').select('*').eq('group_id', GROUP_ID),
      supabase.from('student_credentials').select('*').eq('group_id', GROUP_ID)
    ])

    // Fetch all OTHER sessions of same admin (exclude current)
    const { data: otherSessions } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('admin_id', req.adminId)
      .neq('id', GROUP_ID)

    if (!otherSessions || otherSessions.length === 0) {
      return res.json({ conflict: false })
    }

    for (const session of otherSessions) {

      // ── New voting window vs existing voting window
      if (timesOverlap(votingStart, votingEnd, session.voting_start, session.voting_end)) {
        const hit = await findStudentConflict(
          ownUucms || [], ownIndividuals || [], ownCredentials || [], session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" is already in another active voting session during this time. Change the voting window or remove the conflict.`
          })
        }
      }

      // ── New voting window vs existing published result window
      if (
        session.is_published && session.result_start && session.result_end &&
        timesOverlap(votingStart, votingEnd, session.result_start, session.result_end)
      ) {
        const hit = await findStudentConflict(
          ownUucms || [], ownIndividuals || [], ownCredentials || [], session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" already has results published during this voting window. Change the voting window or remove the conflict.`
          })
        }
      }

      // ── New result window vs existing voting window (only if result provided)
      if (
        resultStart && resultEnd &&
        timesOverlap(resultStart, resultEnd, session.voting_start, session.voting_end)
      ) {
        const hit = await findStudentConflict(
          ownUucms || [], ownIndividuals || [], ownCredentials || [], session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" is in an active voting session during this result window. Change the result window or remove the conflict.`
          })
        }
      }

      // ── New result window vs existing published result window
      if (
        resultStart && resultEnd &&
        session.is_published && session.result_start && session.result_end &&
        timesOverlap(resultStart, resultEnd, session.result_start, session.result_end)
      ) {
        const hit = await findStudentConflict(
          ownUucms || [], ownIndividuals || [], ownCredentials || [], session.id
        )
        if (hit) {
          return res.json({
            conflict: true,
            message: `"${hit}" already has results published during this result window. Change the result window or remove the conflict.`
          })
        }
      }
    }

    return res.json({ conflict: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 5 — AUTH ROUTES
// ============================================================



// ── STEP 1: Send OTP before creating account
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    // Check if email already exists
    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 })
    const alreadyExists = users?.some(u => u.email === email.toLowerCase().trim())
    if (alreadyExists) {
      return res.status(409).json({ error: 'An account with this email already exists.' })
    }

    // Generate OTP
    const otp = crypto.randomInt(100000, 999999).toString()
    const expiresAt = Date.now() + 10 * 60 * 1000  // 10 minutes

    // Store OTP + password in Supabase otps table
    await supabase.from('otps').upsert({
      email:      email.toLowerCase().trim(),
      otp,
      type:       'signup',
      password,
      expires_at: new Date(expiresAt).toISOString()
    }, { onConflict: 'email,type' })

    // Send OTP email
    await mailer.sendMail({
      from: `"VoterScan" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Verify your VoterScan Account',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="color: #1a56db; margin: 0;">VoterScan</h2>
            <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Admin Portal</p>
          </div>
          <div style="background: #ffffff; border-radius: 8px; padding: 28px; border: 1px solid #e2e8f0;">
            <h3 style="color: #0f172a; margin-top: 0;">Verify Your Email</h3>
            <p style="color: #475569; font-size: 15px;">Use the code below to verify your email and complete registration. It expires in <strong>10 minutes</strong>.</p>
            <div style="text-align: center; margin: 28px 0;">
              <span style="
                display: inline-block;
                font-size: 38px;
                font-weight: 800;
                letter-spacing: 12px;
                color: #1a56db;
                background: #eff6ff;
                border: 2px dashed #93c5fd;
                border-radius: 10px;
                padding: 14px 24px;
                font-family: 'Courier New', monospace;
              ">${otp}</span>
            </div>
            <p style="color: #94a3b8; font-size: 13px; text-align: center;">
              If you didn't request this, you can safely ignore this email.
            </p>
          </div>
          <p style="color: #cbd5e1; font-size: 12px; text-align: center; margin-top: 20px;">
            © VoterScan · Do not reply to this email
          </p>
        </div>
      `
    })

    res.json({ message: 'OTP sent to your email. Please verify to complete signup.' })
  } catch (err) {
    console.error('Signup OTP error:', err.message)
    res.status(500).json({ error: 'Failed to send OTP. Please try again.' })
  }
})

// ── STEP 2: Verify OTP and create account
app.post('/api/auth/verify-signup-otp', async (req, res) => {
  try {
    const { email, otp } = req.body
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' })
    }

    const key = email.toLowerCase().trim()

    const { data: otpRow } = await supabase
      .from('otps')
      .select('*')
      .eq('email', key)
      .eq('type', 'signup')
      .single()

    if (!otpRow) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' })
    }
    if (new Date() > new Date(otpRow.expires_at)) {
      await supabase.from('otps').delete().eq('email', key).eq('type', 'signup')
      return res.status(400).json({ error: 'OTP has expired. Please sign up again.' })
    }
    if (otpRow.otp !== otp.trim()) {
      return res.status(400).json({ error: 'Incorrect OTP. Please try again.' })
    }

    // OTP valid — create the account now
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: otpRow.password,
      email_confirm: true
    })

    if (error) return res.status(400).json({ error: error.message })

    const userId = data.user?.id
    if (userId) {
      await supabase.from('admins').insert({ id: userId, email, phone: null })
    }

    // Clean up
    await supabase.from('otps').delete().eq('email', key).eq('type', 'signup')

    res.json({ message: 'Account verified and created successfully! You can now sign in.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Identifier and password are required' })
    }

    // ── CHECK IF BLOCKED ──
    const blockedMinutes = isBlocked(identifier)
    if (blockedMinutes) {
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${blockedMinutes} minute${blockedMinutes > 1 ? 's' : ''}.`,
        blocked: true,
        minutesLeft: blockedMinutes
      })
    }

    const isEmail = identifier.includes('@')
    const { data, error } = isEmail
      ? await supabase.auth.signInWithPassword({ email: identifier, password })
      : await supabase.auth.signInWithPassword({ phone: identifier, password })

    if (error) {
      // ── RECORD FAILED ATTEMPT ──
      const attempts  = recordFailedAttempt(identifier)
      const remaining = MAX_ATTEMPTS - attempts

      if (remaining <= 0) {
        return res.status(429).json({
          error: `Too many failed attempts. Account locked for ${BLOCK_MINUTES} minutes.`,
          blocked: true,
          minutesLeft: BLOCK_MINUTES
        })
      }

      return res.status(401).json({
        error: `Incorrect password. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining before lockout.`,
        attemptsLeft: remaining
      })
    }

    // ── SUCCESS — clear failed attempts ──
    clearFailedAttempts(identifier)

    res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      user:          data.user
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/auth/session', verifyToken, async (req, res) => {
  res.json({ adminId: req.adminId, email: req.user.email })
})

app.post('/api/auth/logout', verifyToken, async (req, res) => {
  try {
    const token = req.headers['authorization'].split(' ')[1]
    await supabase.auth.admin.signOut(token)
    res.json({ message: 'Logged out successfully' })
  } catch (err) {
    res.json({ message: 'Logged out' })
  }
})

// ============================================================
//  SECTION 5B — FORGOT PASSWORD (NODEMAILER OTP FLOW)
// ============================================================



// ── Nodemailer transporter (Gmail)
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD   // App Password, NOT your Gmail password
  }
})

// ── SEND OTP
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    // Check if this email exists in Supabase auth
    const { data: users, error: listError } = await supabase.auth.admin.listUsers()
    if (listError) return res.status(500).json({ error: listError.message })

    const userExists = users?.users?.some(u => u.email === email.toLowerCase().trim())
    if (!userExists) {
      // Don't reveal whether email exists — silent success
      return res.json({ message: 'If this email is registered, an OTP has been sent.' })
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    // Store OTP in Supabase otps table
    await supabase.from('otps').upsert({
      email:      email.toLowerCase().trim(),
      otp,
      type:       'forgot_password',
      expires_at: expiresAt
    }, { onConflict: 'email,type' })

    // Send email
    await mailer.sendMail({
      from: `"VoterScan" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Your VoterScan Password Reset Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="color: #1a56db; margin: 0;">VoterScan</h2>
            <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Admin Portal</p>
          </div>
          <div style="background: #ffffff; border-radius: 8px; padding: 28px; border: 1px solid #e2e8f0;">
            <h3 style="color: #0f172a; margin-top: 0;">Password Reset Request</h3>
            <p style="color: #475569; font-size: 15px;">Use the code below to reset your password. It expires in <strong>10 minutes</strong>.</p>
            <div style="text-align: center; margin: 28px 0;">
              <span style="
                display: inline-block;
                font-size: 38px;
                font-weight: 800;
                letter-spacing: 12px;
                color: #1a56db;
                background: #eff6ff;
                border: 2px dashed #93c5fd;
                border-radius: 10px;
                padding: 14px 24px;
                font-family: 'Courier New', monospace;
              ">${otp}</span>
            </div>
            <p style="color: #94a3b8; font-size: 13px; text-align: center;">
              If you didn't request this, you can safely ignore this email.
            </p>
          </div>
          <p style="color: #cbd5e1; font-size: 12px; text-align: center; margin-top: 20px;">
            © VoterScan · Do not reply to this email
          </p>
        </div>
      `
    })

    res.json({ message: 'If this email is registered, an OTP has been sent.' })
  } catch (err) {
    console.error('Forgot password error:', err.message)
    res.status(500).json({ error: 'Failed to send OTP. Please try again.' })
  }
})

// ── VERIFY OTP + SET NEW PASSWORD
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'email, otp and newPassword are required' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    const key = email.toLowerCase().trim()

    const { data: otpRow } = await supabase
      .from('otps')
      .select('*')
      .eq('email', key)
      .eq('type', 'forgot_password')
      .single()

    // OTP not found
    if (!otpRow) {
      return res.status(400).json({ error: 'No OTP found for this email. Please request a new one.' })
    }

    // OTP expired
    if (new Date() > new Date(otpRow.expires_at)) {
      await supabase.from('otps').delete().eq('email', key).eq('type', 'forgot_password')
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' })
    }

    // Wrong OTP
    if (otpRow.otp !== otp.trim()) {
      return res.status(400).json({ error: 'Incorrect OTP. Please check and try again.' })
    }

    // OTP is valid — find the user and update password
    const { data: users, error: listError } = await supabase.auth.admin.listUsers()
    if (listError) return res.status(500).json({ error: listError.message })

    const user = users?.users?.find(u => u.email === key)
    if (!user) return res.status(404).json({ error: 'User not found.' })

    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      password: newPassword
    })

    if (updateError) return res.status(500).json({ error: updateError.message })

    // Clean up — OTP used, delete it
    await supabase.from('otps').delete().eq('email', key).eq('type', 'forgot_password')

    res.json({ message: 'Password reset successfully.' })
  } catch (err) {
    console.error('Verify OTP error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
// ============================================================
//  SECTION 6 — ADMIN CODE ROUTES
// ============================================================

app.get('/api/admin/code', verifyToken, async (req, res) => {
  try {
    const { data: admin, error } = await supabase
      .from('admins')
      .select('unique_code')
      .eq('id', req.adminId)
      .single()

    if (error) return res.status(500).json({ error: error.message })
    res.json({ unique_code: admin?.unique_code || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/admin/code', verifyToken, async (req, res) => {
  try {
    const raw  = (req.body.code || '').trim()
    const code = raw.toUpperCase()

    if (!code)              return res.status(400).json({ error: 'Code cannot be empty' })
    if (code.length < 4)   return res.status(400).json({ error: 'Code must be at least 4 characters' })
    if (!/^[A-Z0-9]+$/.test(code)) {
      return res.status(400).json({ error: 'Only letters and numbers allowed' })
    }

    const { data: existing } = await supabase
      .from('admins')
      .select('id')
      .eq('unique_code', code)
      .single()

    if (existing && existing.id !== req.adminId) {
      return res.status(409).json({ error: `Code "${code}" is already in use by another admin` })
    }

    const { error } = await supabase
      .from('admins')
      .update({ unique_code: code })
      .eq('id', req.adminId)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ message: 'Admin code set successfully', code })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 7 — SESSION (VOTING GROUP) ROUTES
// ============================================================

app.get('/api/sessions', verifyToken, async (req, res) => {
  try {
    const { data: groups, error } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('admin_id', req.adminId)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    res.json({ groups: groups || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── CREATE SESSION
app.post('/api/sessions', verifyToken, async (req, res) => {
  try {
    const {
      college, year, semester, section,
      votingStart, votingEnd,
      candidates,
      uucmsRanges,
      individualStudents,
      credentials
    } = req.body

    if (!college || !year || !semester || !section) {
      return res.status(400).json({ error: 'All class details are required' })
    }
    if (!votingStart || !votingEnd) {
      return res.status(400).json({ error: 'Voting schedule is required' })
    }

    // Fetch admin code
    const { data: admin } = await supabase
      .from('admins')
      .select('unique_code')
      .eq('id', req.adminId)
      .single()

    if (!admin?.unique_code) {
      return res.status(400).json({ error: 'Please set your admin code before creating a session' })
    }

    
    // Insert voting group
    const { data: group, error: groupError } = await supabase
      .from('voting_groups')
      .insert({
        admin_id:     req.adminId,
        admin_code:   admin.unique_code,
        college,
        year,
        semester,
        section,
        voting_start: votingStart,
        voting_end:   votingEnd
      })
      .select()
      .single()

    if (groupError) return res.status(500).json({ error: groupError.message })

    const GROUP_ID = group.id

    // Insert candidates
    if (candidates?.length) {
      for (const c of candidates) {
        if (!c.name) continue
        await supabase.from('candidates').insert({
          group_id: GROUP_ID, name: c.name, photo_url: c.photoUrl || null
        })
      }
    }

    // Insert UUCMS ranges
    if (uucmsRanges?.length) {
      for (const r of uucmsRanges) {
        if (!r.rangeFrom || !r.rangeTo) continue
        await supabase.from('uucms_ranges').insert({
          group_id: GROUP_ID, range_from: r.rangeFrom, range_to: r.rangeTo
        })
      }
    }

    // Insert individual students
    if (individualStudents?.length) {
      for (const s of individualStudents) {
        if (!s.studentId) continue
        await supabase.from('individual_students').insert({
          group_id: GROUP_ID, student_id: s.studentId, student_name: s.studentName || null
        })
      }
    }

    // Insert student credentials
    if (credentials?.length) {
      for (const c of credentials) {
        if (!c.studentId) continue
        await supabase.from('student_credentials').insert({
          group_id:     GROUP_ID,
          student_id:   c.studentId,
          student_name: c.username || null,
          can_vote:     c.canVote === true || c.canVote === 'yes'
        })
      }
    }

    res.json({ message: 'Session created successfully', groupId: GROUP_ID })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── PUBLISH RESULTS
app.post('/api/sessions/:id/publish', verifyToken, async (req, res) => {
  try {
    const GROUP_ID = req.params.id
    const { resultStart, resultEnd, extraRanges } = req.body

    if (!resultStart || !resultEnd) {
      return res.status(400).json({ error: 'Result start and end time are required' })
    }

    if (new Date(resultStart) >= new Date(resultEnd)) {
      return res.status(400).json({ error: 'Result end time must be after start time' })
    }

    // Verify ownership
    const { data: group } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('id', GROUP_ID)
      .single()

    if (!group || group.admin_id !== req.adminId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    
    // Update group
    const { error: updateError } = await supabase
      .from('voting_groups')
      .update({
        is_published:  true,
        result_start:  new Date(resultStart).toISOString(),
        result_end:    new Date(resultEnd).toISOString()
      })
      .eq('id', GROUP_ID)

    if (updateError) return res.status(500).json({ error: updateError.message })
      

    // Delete old extra result ranges then re-insert
    await supabase.from('result_ranges').delete().eq('group_id', GROUP_ID)

    if (extraRanges?.length) {
      for (const r of extraRanges) {
        if (!r.rangeFrom || !r.rangeTo) continue
        await supabase.from('result_ranges').insert({
          group_id: GROUP_ID, range_from: r.rangeFrom, range_to: r.rangeTo
        })
      }
    }

    res.json({ message: 'Results published successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 8 — CANDIDATE ROUTES
// ============================================================

app.get('/api/candidates', async (req, res) => {
  try {
    const { group } = req.query
    if (!group) return res.status(400).json({ error: 'group query param required' })

    const { data: candidates, error } = await supabase
      .from('candidates')
      .select('*')
      .eq('group_id', group)
      .order('created_at', { ascending: true })

    if (error) return res.status(500).json({ error: error.message })
    res.json({ candidates: candidates || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 9 — QR VERIFICATION ROUTE
// ============================================================

app.post('/api/verify/student', async (req, res) => {
  try {
    const { studentId, studentName = '', adminCode } = req.body

    if (!studentId || !adminCode) {
      return res.status(400).json({ error: 'studentId and adminCode are required' })
    }

    const code = adminCode.trim().toUpperCase()
    const now  = new Date().toISOString()

    const { data: adminRow } = await supabase
      .from('admins')
      .select('id')
      .eq('unique_code', code)
      .single()

    if (!adminRow) {
      return res.status(404).json({ error: 'Invalid admin code. Please check and try again.' })
    }

    // Check result window
    const { data: resultGroups } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('admin_code', code)
      .eq('is_published', true)
      .lte('result_start', now)
      .gte('result_end', now)

    if (resultGroups?.length) {
      for (const g of resultGroups) {
        const inCred  = await isInCredentials(studentId, g.id)
        const inRange = await isInUUCMSRange(studentId, g.id)

        if (inCred || inRange) {
          return res.json({
            redirect: 'result',
            url: `result.html?group=${encodeURIComponent(g.id)}&id=${encodeURIComponent(studentId)}`
          })
        }
      }
    }

    // Find active voting group
    const { data: votingGroups } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('admin_code', code)
      .lte('voting_start', now)
      .gte('voting_end', now)

    if (!votingGroups?.length) {
      return res.status(404).json({ error: 'No active voting session for this admin code.' })
    }

    let matchedGroup = null
    let matchedCred  = null
    let resolvedName = studentName

    for (const g of votingGroups) {
      const { data: cred } = await supabase
        .from('student_credentials')
        .select('*')
        .eq('group_id', g.id)
        .eq('student_id', studentId)
        .single()

      if (cred) {
        matchedGroup = g
        matchedCred  = cred
        break
      }

      const inRange = await isInUUCMSRange(studentId, g.id)
      if (inRange) { matchedGroup = g; break }

      const indStudent = await isInIndividualList(studentId, g.id)
      if (indStudent) {
        matchedGroup = g
        if (indStudent.student_name) resolvedName = indStudent.student_name
        break
      }
    }

    if (!matchedGroup) {
      return res.status(404).json({ error: 'Student ID not recognized in this voting session.' })
    }

    const GROUP_ID = matchedGroup.id

    const { data: existingVoter } = await supabase
      .from('voters')
      .select('*')
      .eq('group_id', GROUP_ID)
      .eq('student_id', studentId)
      .single()

    if (existingVoter?.has_voted) {
      return res.status(409).json({ error: 'You have already voted! Duplicate voting is not allowed.' })
    }

    if (matchedCred) {
      const finalName = matchedCred.student_name || resolvedName

      if (matchedCred.can_vote) {
        await supabase.from('voters').upsert({
          group_id:       GROUP_ID,
          student_id:     studentId,
          student_name:   finalName,
          face_image_url: null,
          has_voted:      false
        }, { onConflict: 'group_id, student_id' })

        return res.json({
          redirect: 'home',
          url: `home.html?id=${encodeURIComponent(studentId)}&name=${encodeURIComponent(finalName)}&group=${encodeURIComponent(GROUP_ID)}&canVote=true`
        })
      } else {
        return res.json({
          redirect: 'home',
          url: `home.html?id=${encodeURIComponent(studentId)}&name=${encodeURIComponent(finalName)}&group=${encodeURIComponent(GROUP_ID)}&canVote=false`
        })
      }
    } else {
      const qrText = `${studentId}|${resolvedName}|${code}`
      return res.json({
        redirect: 'blink',
        url: `blink.html?code=${encodeURIComponent(qrText)}&group=${encodeURIComponent(GROUP_ID)}`
      })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 10 — VOTER ROUTES
// ============================================================

app.get('/api/voters/status', async (req, res) => {
  try {
    const { group, id } = req.query
    if (!group || !id) {
      return res.status(400).json({ error: 'group and id query params required' })
    }

    const { data: voter } = await supabase
      .from('voters')
      .select('*')
      .eq('group_id', group)
      .eq('student_id', id)
      .single()

    res.json({
      exists:       !!voter,
      hasVoted:     voter?.has_voted || false,
      faceImageUrl: voter?.face_image_url || null
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/voters/descriptors — fetch all face descriptors for a group
app.get('/api/voters/descriptors', async (req, res) => {
  try {
    const { group } = req.query
    if (!group) return res.status(400).json({ error: 'group param required' })

    const { data: voters, error } = await supabase
      .from('voters')
      .select('student_id, student_name, face_image_url, face_descriptor')
      .eq('group_id', group)
      .not('face_descriptor', 'is', null)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ voters: voters || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/voters/register', upload.single('face'), async (req, res) => {
  try {
    const { groupId, studentId, studentName } = req.body

    if (!groupId || !studentId) {
      return res.status(400).json({ error: 'groupId and studentId are required' })
    }

    let faceImageUrl = null

    if (req.file) {
      const fileName = `${groupId}_${studentId}_${Date.now()}.jpg`

      const { error: uploadError } = await supabase
        .storage
        .from('voting-images')
        .upload(`faces/${fileName}`, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true
        })

      if (!uploadError) {
        const { data: urlData, error: signError } = await supabase
          .storage
          .from('voting-images')
          .createSignedUrl(`faces/${fileName}`, 604800)
        if (!signError) faceImageUrl = urlData.signedUrl
      } else {
        console.error('Face upload error:', uploadError.message)
      }
    }

    // Parse face descriptor if sent
let faceDescriptor = null



if (req.body.faceDescriptor) {
  try {
    faceDescriptor = JSON.parse(req.body.faceDescriptor)
    
  } catch (err) {
    console.error("Descriptor parse failed:", err)
  }
}

const voterData = {
  group_id:       groupId,
  student_id:     studentId,
  student_name:   studentName || null,
  face_image_url: faceImageUrl,
  has_voted:      false
}

if (faceDescriptor) {
  voterData.face_descriptor = faceDescriptor
}

const { error: voterError } = await supabase
  .from('voters')
  .upsert(voterData, { onConflict: 'group_id, student_id' })

    if (voterError) return res.status(500).json({ error: voterError.message })

    res.json({ message: 'Voter registered successfully', faceImageUrl })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/voters/list', verifyToken, async (req, res) => {
  try {
    const { group } = req.query
    if (!group) return res.status(400).json({ error: 'group param required' })

    const { data: voters, error } = await supabase
      .from('voters')
      .select('*')
      .eq('group_id', group)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    res.json({ voters: voters || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 11 — VOTE SUBMISSION ROUTE
// ============================================================

app.post('/api/vote', async (req, res) => {
  try {
    const { groupId, studentId, candidateId } = req.body

    if (!groupId || !studentId || !candidateId) {
      return res.status(400).json({ error: 'groupId, studentId and candidateId are required' })
    }

    // ── ATOMIC: update only if has_voted is currently FALSE
    // If already voted, Supabase returns 0 rows updated → we catch it
    const { data: updated, error: updateError } = await supabase
      .from('voters')
      .update({ has_voted: true, voted_candidate_id: candidateId })
      .eq('group_id', groupId)
      .eq('student_id', studentId)
      .eq('has_voted', false)   // ← KEY: only updates if NOT yet voted
      .select()

    if (updateError) return res.status(500).json({ error: updateError.message })

    // If 0 rows updated → already voted (or voter not found)
    if (!updated || updated.length === 0) {
      return res.status(409).json({ 
        error: 'already_voted',
        message: 'You have already voted. Duplicate voting is not allowed.'
      })
    }

    // ── Increment candidate vote count
    const { data: candData } = await supabase
      .from('candidates')
      .select('vote_count')
      .eq('id', candidateId)
      .single()

    const { error: candError } = await supabase
      .from('candidates')
      .update({ vote_count: (candData?.vote_count || 0) + 1 })
      .eq('id', candidateId)

    if (candError) return res.status(500).json({ error: candError.message })

    res.json({ message: 'Vote submitted successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// ============================================================
//  SECTION 12 — RESULTS ROUTES
// ============================================================

app.get('/api/results/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params
    const { id: studentId } = req.query
    const now = new Date().toISOString()

    const { data: groups } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('id', groupId)
      .eq('is_published', true)
      .lte('result_start', now)
      .gte('result_end', now)

    const group = groups?.[0]

    if (!group) {
      return res.status(403).json({ error: 'Results are not available yet.' })
    }

    if (studentId) {
      const { data: uucmsRanges }   = await supabase.from('uucms_ranges').select('*').eq('group_id', groupId)
      const { data: resultRanges }  = await supabase.from('result_ranges').select('*').eq('group_id', groupId)
      const { data: cred }          = await supabase
        .from('student_credentials')
        .select('*')
        .eq('group_id', groupId)
        .eq('student_id', studentId)
        .single()

      const allowed =
        (uucmsRanges  && checkRangeLogic(studentId, uucmsRanges))  ||
        (resultRanges && checkRangeLogic(studentId, resultRanges)) ||
        !!cred

      if (!allowed) {
        return res.status(403).json({ error: 'You are not authorized to view these results.' })
      }
    }

    const { data: candidates, error } = await supabase
      .from('candidates')
      .select('*')
      .eq('group_id', groupId)
      .order('vote_count', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })

    res.json({ group, candidates: candidates || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/results/:groupId/publish-settings', verifyToken, async (req, res) => {
  try {
    const { groupId } = req.params

    const { data: group } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('id', groupId)
      .eq('admin_id', req.adminId)
      .single()

    if (!group) return res.status(403).json({ error: 'Unauthorized or group not found' })

    const [
      { data: uucmsRanges },
      { data: studentCreds },
      { data: individualStudents },
      { data: resultRanges }
    ] = await Promise.all([
      supabase.from('uucms_ranges').select('*').eq('group_id', groupId),
      supabase.from('student_credentials').select('*').eq('group_id', groupId),
      supabase.from('individual_students').select('*').eq('group_id', groupId),
      supabase.from('result_ranges').select('*').eq('group_id', groupId)
    ])

    res.json({
      group,
      uucmsRanges:        uucmsRanges        || [],
      studentCreds:       studentCreds       || [],
      individualStudents: individualStudents || [],
      resultRanges:       resultRanges       || []
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 11B — DELETE SESSION ROUTE
// ============================================================

app.delete('/api/sessions/:id', verifyToken, async (req, res) => {
  try {
    const GROUP_ID = req.params.id
    const { password } = req.body

    if (!password) {
      return res.status(400).json({ error: 'Password is required' })
    }

    // Verify ownership first
    const { data: group } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('id', GROUP_ID)
      .eq('admin_id', req.adminId)
      .single()

    if (!group) {
      return res.status(403).json({ error: 'Unauthorized or session not found' })
    }

    // Re-authenticate password
    const { data: adminUser } = await supabase
      .from('admins')
      .select('email')
      .eq('id', req.adminId)
      .single()

    if (!adminUser?.email) {
      return res.status(500).json({ error: 'Could not verify admin identity' })
    }

    const { error: authError } = await supabase.auth.signInWithPassword({
      email:    adminUser.email,
      password: password
    })

    if (authError) {
      return res.status(401).json({ error: 'Incorrect password', wrongPassword: true })
    }
 // If verifyOnly — just confirm password is correct, don't delete
    if (req.body.verifyOnly) {
      return res.json({ readyToDelete: true })
    }

    // Delete all related data in order
    await supabase.from('result_ranges').delete().eq('group_id', GROUP_ID)
    await supabase.from('uucms_ranges').delete().eq('group_id', GROUP_ID)
    await supabase.from('individual_students').delete().eq('group_id', GROUP_ID)
    await supabase.from('student_credentials').delete().eq('group_id', GROUP_ID)
    await supabase.from('voters').delete().eq('group_id', GROUP_ID)
    await supabase.from('candidates').delete().eq('group_id', GROUP_ID)
    await supabase.from('voting_groups').delete().eq('id', GROUP_ID)

    res.json({ message: 'Session deleted successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 13 — IMAGE UPLOAD ROUTE
// ============================================================

app.post('/api/upload/candidate-photo', verifyToken, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    const groupId  = req.body.groupId || 'general'
    const fileName = `${groupId}_${Date.now()}_${req.file.originalname}`

    const { error: uploadError } = await supabase
      .storage
      .from('voting-images')
      .upload(`candidates/${fileName}`, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      })

    if (uploadError) return res.status(500).json({ error: uploadError.message })

    const { data: urlData, error: signError } = await supabase
      .storage
      .from('voting-images')
      .createSignedUrl(`candidates/${fileName}`, 604800)

    if (signError) return res.status(500).json({ error: signError.message })

    res.json({ publicUrl: urlData.signedUrl })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
//  SECTION 14 — HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})
// ============================================================
//  SECTION 14B — IMAGE PROXY ROUTE
// ============================================================

app.get('/api/image/*', async (req, res) => {
  try {
    const filePath = req.params[0]
    if (!filePath) return res.status(400).json({ error: 'File path required' })

    const { data, error } = await supabase
      .storage
      .from('voting-images')
      .createSignedUrl(filePath, 60)

    if (error) return res.status(500).json({ error: error.message })

    res.redirect(data.signedUrl)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── EDIT SESSION (voting dates + result dates)
app.put('/api/sessions/:id', verifyToken, async (req, res) => {
  try {
    const GROUP_ID = req.params.id
    const { votingStart, votingEnd, resultStart, resultEnd } = req.body

    if (!votingStart || !votingEnd) {
      return res.status(400).json({ error: 'Voting start and end are required' })
    }
    if (new Date(votingStart) >= new Date(votingEnd)) {
      return res.status(400).json({ error: 'Voting end must be after start' })
    }
    if (resultStart && resultEnd && new Date(resultStart) >= new Date(resultEnd)) {
      return res.status(400).json({ error: 'Result end must be after result start' })
    }

    const { data: group } = await supabase
      .from('voting_groups')
      .select('*')
      .eq('id', GROUP_ID)
      .eq('admin_id', req.adminId)
      .single()

    if (!group) return res.status(403).json({ error: 'Unauthorized or session not found' })

    const updates = {
      voting_start: new Date(votingStart).toISOString(),
      voting_end:   new Date(votingEnd).toISOString()
    }

    if (resultStart && resultEnd) {
      updates.result_start = new Date(resultStart).toISOString()
      updates.result_end   = new Date(resultEnd).toISOString()
    }

    const { error } = await supabase
      .from('voting_groups')
      .update(updates)
      .eq('id', GROUP_ID)

    if (error) return res.status(500).json({ error: error.message })

    res.json({ message: 'Session updated successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// ============================================================
//  SECTION 15 — START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────      ┐
  │   Smart Voting Authentication System          │
  │   Backend running on port ${PORT}             │
  │   Health: http://localhost:${PORT}/api/health │
  └─────────────────────────────────────────      ┘
  `)
})