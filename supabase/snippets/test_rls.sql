SET LOCAL role = 'authenticated';
SET LOCAL request.jwt.claims = '{"sub": "24378dcd-ccde-4275-83a4-02a7d780bc3e", "role": "authenticated"}';
SELECT id, title, user_id FROM documents WHERE id = 1;
