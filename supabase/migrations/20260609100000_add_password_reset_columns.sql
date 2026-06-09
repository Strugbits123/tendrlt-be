ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255),
ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP WITH TIME ZONE;
