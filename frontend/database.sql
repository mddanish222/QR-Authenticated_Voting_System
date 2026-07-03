-- ============================================
-- database.sql
-- TABLE 1: admins
-- Stores admin accounts (handled by Supabase Auth)
-- We just store extra info here
-- ============================================
CREATE TABLE admins (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLE 2: voting_groups
-- Each admin creates one voting setup (class)
-- ============================================
CREATE TABLE voting_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES admins(id) ON DELETE CASCADE,

  college TEXT NOT NULL,
  year TEXT NOT NULL,
  semester TEXT NOT NULL,
  section TEXT NOT NULL,

  voting_start TIMESTAMP,
  voting_end TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLE 3: candidates
-- Each candidate belongs to a voting group
-- ============================================
CREATE TABLE candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES voting_groups(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  photo_url TEXT,

  vote_count INTEGER DEFAULT 0,

  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLE 4: uucms_ranges
-- The allowed student ID ranges per group
-- ============================================
CREATE TABLE uucms_ranges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES voting_groups(id) ON DELETE CASCADE,

  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL
);

-- ============================================
-- TABLE 5: student_credentials
-- Admin manually adds students with permission
-- ============================================
CREATE TABLE student_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES voting_groups(id) ON DELETE CASCADE,

  student_id TEXT NOT NULL,
  student_name TEXT,
  can_vote BOOLEAN DEFAULT TRUE
);

-- ============================================
-- TABLE 6: voters
-- Students who passed QR + face verification
-- ============================================
CREATE TABLE voters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES voting_groups(id) ON DELETE CASCADE,

  student_id TEXT NOT NULL,
  student_name TEXT,
  face_image_url TEXT,

  has_voted BOOLEAN DEFAULT FALSE,
  voted_candidate_id UUID REFERENCES candidates(id),

  created_at TIMESTAMP DEFAULT NOW(),

  -- Prevent same student voting twice in same group
  UNIQUE(group_id, student_id)
);

-- Enable RLS on all tables
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE voting_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE uucms_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE voters ENABLE ROW LEVEL SECURITY;

-- ✅ ADMINS: can only see their own row
CREATE POLICY "Admin sees own profile"
  ON admins FOR ALL
  USING (auth.uid() = id);

-- ✅ VOTING GROUPS: admin sees only their groups
CREATE POLICY "Admin sees own groups"
  ON voting_groups FOR ALL
  USING (auth.uid() = admin_id);

-- ✅ CANDIDATES: admin sees candidates in their groups
CREATE POLICY "Admin sees own candidates"
  ON candidates FOR ALL
  USING (
    group_id IN (
      SELECT id FROM voting_groups WHERE admin_id = auth.uid()
    )
  );

-- ✅ UUCMS RANGES: same pattern
CREATE POLICY "Admin sees own ranges"
  ON uucms_ranges FOR ALL
  USING (
    group_id IN (
      SELECT id FROM voting_groups WHERE admin_id = auth.uid()
    )
  );

-- ✅ STUDENT CREDENTIALS: same pattern
CREATE POLICY "Admin sees own credentials"
  ON student_credentials FOR ALL
  USING (
    group_id IN (
      SELECT id FROM voting_groups WHERE admin_id = auth.uid()
    )
  );

-- ✅ VOTERS: admin sees voters in their groups
-- Also allow anonymous insert (for QR scanner page)
CREATE POLICY "Admin sees own voters"
  ON voters FOR SELECT
  USING (
    group_id IN (
      SELECT id FROM voting_groups WHERE admin_id = auth.uid()
    )
  );

CREATE POLICY "Anyone can insert voter"
  ON voters FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update voter"
  ON voters FOR UPDATE
  USING (true);

-- ✅ Anyone can read candidates (for voting page)
CREATE POLICY "Public can read candidates"
  ON candidates FOR SELECT
  USING (true);

-- ✅ Anyone can read student_credentials (for QR check)
CREATE POLICY "Public can read credentials"
  ON student_credentials FOR SELECT
  USING (true);

-- ✅ Anyone can read uucms_ranges (for QR check)
CREATE POLICY "Public can read ranges"
  ON uucms_ranges FOR SELECT
  USING (true);

-- ✅ Anyone can read voting_groups (for time check)
CREATE POLICY "Public can read groups"
  ON voting_groups FOR SELECT
  USING (true);

  -- Allow anyone to upload to voting-images
INSERT INTO storage.buckets (id, name, public)
VALUES ('voting-images', 'voting-images', true)
ON CONFLICT DO NOTHING;

CREATE POLICY "Anyone can upload images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'voting-images');

CREATE POLICY "Anyone can view images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'voting-images');
  

-- Add new columns to voting_groups
ALTER TABLE voting_groups
ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS result_start TIMESTAMP,
ADD COLUMN IF NOT EXISTS result_end   TIMESTAMP;

-- New table for result viewing ranges
CREATE TABLE IF NOT EXISTS result_ranges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID REFERENCES voting_groups(id) ON DELETE CASCADE,
  range_from TEXT NOT NULL,
  range_to   TEXT NOT NULL
);

-- Enable RLS
ALTER TABLE result_ranges ENABLE ROW LEVEL SECURITY;

-- Admin can manage their result ranges
CREATE POLICY "Admin manages result ranges"
  ON result_ranges FOR ALL
  USING (
    group_id IN (
      SELECT id FROM voting_groups WHERE admin_id = auth.uid()
    )
  );

-- Anyone can read result ranges (for QR check)
CREATE POLICY "Public can read result ranges"
  ON result_ranges FOR SELECT
  USING (true);
/*for admin unique code*/
ALTER TABLE admins ADD COLUMN unique_code TEXT UNIQUE NULL;
ALTER TABLE voting_groups ADD COLUMN admin_code TEXT NULL;



create table individual_students (
  id uuid default gen_random_uuid() primary key,
  group_id uuid references voting_groups(id) on delete cascade,
  student_id text not null,
  student_name text,
  created_at timestamp with time zone default now()
);

ALTER TABLE voters ADD COLUMN face_descriptor float8[];

-- Create otps table
CREATE TABLE otps (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email      text NOT NULL,
  otp        text NOT NULL,
  type       text NOT NULL,
  password   text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Unique constraint so upsert works correctly
ALTER TABLE otps
  ADD CONSTRAINT otps_email_type_unique UNIQUE (email, type);

-- Disable RLS (service role key only touches this table)
ALTER TABLE otps DISABLE ROW LEVEL SECURITY;

-- Auto-delete expired rows (runs cleanup passively)
CREATE INDEX otps_expires_at_idx ON otps (expires_at);

  // for checking
  SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public'
ORDER BY table_name;


//output
table_name
──────────────────
admins
candidates
student_credentials
uucms_ranges
voters
voting_groups


