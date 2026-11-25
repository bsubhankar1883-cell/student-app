const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to hash password
function hashPassword(plainText) {
    return crypto.createHash('sha256').update(plainText).digest('hex');
}

// -------------------------------------------------------------
// Health Check Endpoint
// -------------------------------------------------------------
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'College Library Student API', timestamp: new Date() });
});

// -------------------------------------------------------------
// 1. Student Login Endpoint
// Accepts: { loginId: "email or member_id", password: "..." }
// -------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
    const { loginId, password } = req.body;
    if (!loginId || !password) {
        return res.status(400).json({ success: false, message: 'Member ID/Email and Password are required.' });
    }

    try {
        const query = `
            SELECT m.member_id, m.member_name, m.email, m.phone, m.department, m.semester, m.status,
                   sa.password_hash, sa.is_activated
            FROM members m
            LEFT JOIN student_auth sa ON m.member_id = sa.member_id
            WHERE (m.email = ? OR m.member_id = ?) AND m.membership_type = 'STUDENT'
            LIMIT 1
        `;
        const [rows] = await pool.query(query, [loginId, loginId]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Student not found in library records.' });
        }

        const student = rows[0];
        if (student.status !== 'ACTIVE') {
            return res.status(403).json({ success: false, message: `Your membership is ${student.status}. Please contact the library.` });
        }

        const inputHash = hashPassword(password);
        const matches = student.password_hash === inputHash || student.password_hash === password;

        if (!matches) {
            return res.status(401).json({ success: false, message: 'Invalid password. If this is your first time, please activate your account.' });
        }

        // Update last login timestamp
        pool.query('UPDATE student_auth SET last_login = NOW() WHERE member_id = ?', [student.member_id]).catch(() => {});

        res.json({
            success: true,
            message: 'Login successful',
            student: {
                memberId: student.member_id,
                name: student.member_name,
                email: student.email,
                phone: student.phone,
                department: student.department,
                semester: student.semester
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Database error occurred', error: err.message });
    }
});

// -------------------------------------------------------------
// 2. First-Time Student Activation
// Accepts: { memberId, email, newPassword }
// -------------------------------------------------------------
app.post('/api/auth/activate', async (req, res) => {
    const { memberId, email, newPassword } = req.body;
    if (!memberId || !email || !newPassword) {
        return res.status(400).json({ success: false, message: 'Member ID, Email, and New Password are required.' });
    }

    try {
        const [members] = await pool.query(
            'SELECT member_id, member_name, status, membership_type FROM members WHERE member_id = ? AND email = ?',
            [memberId, email.trim()]
        );

        if (members.length === 0) {
            return res.status(404).json({ success: false, message: 'No matching student record found with this ID and Email.' });
        }

        const member = members[0];
        if (member.membership_type !== 'STUDENT') {
            return res.status(403).json({ success: false, message: 'This account is not a student membership.' });
        }
        if (member.status !== 'ACTIVE') {
            return res.status(403).json({ success: false, message: 'Membership is inactive or suspended.' });
        }

        const passwordHash = hashPassword(newPassword);

        // Insert or update credentials
        await pool.query(`
            INSERT INTO student_auth (member_id, email, password_hash, is_activated)
            VALUES (?, ?, ?, TRUE)
            ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_activated = TRUE
        `, [memberId, email.trim(), passwordHash]);

        res.json({
            success: true,
            message: 'Account activated successfully! You can now log in.'
        });
    } catch (err) {
        console.error('Activation error:', err);
        res.status(500).json({ success: false, message: 'Database error', error: err.message });
    }
});

// -------------------------------------------------------------
// 3. Student Dashboard Summary
// -------------------------------------------------------------
app.get('/api/student/dashboard', async (req, res) => {
    const memberId = req.query.memberId;
    if (!memberId) {
        return res.status(400).json({ success: false, message: 'memberId is required' });
    }

    try {
        // Active loans
        const [loans] = await pool.query(`
            SELECT t.transaction_id, t.issue_date, t.due_date,
                   b.book_id, b.title, b.author, b.isbn, b.category
            FROM transactions t
            JOIN books b ON t.book_id = b.book_id
            WHERE t.member_id = ? AND t.status = 'ISSUED'
            ORDER BY t.due_date ASC
        `, [memberId]);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let overdueCount = 0;
        let totalFine = 0;

        const enrichedLoans = loans.map(loan => {
            const dueDate = new Date(loan.due_date);
            dueDate.setHours(0, 0, 0, 0);
            const diffTime = dueDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            let status = 'NORMAL';
            let fine = 0;

            if (diffDays < 0) {
                status = 'OVERDUE';
                overdueCount++;
                fine = Math.abs(diffDays) * 5.0; // Rs 5 per day fine
                totalFine += fine;
            } else if (diffDays <= 3) {
                status = 'DUE_SOON';
            }

            return {
                transactionId: loan.transaction_id,
                bookId: loan.book_id,
                title: loan.title,
                author: loan.author,
                isbn: loan.isbn,
                category: loan.category,
                issueDate: loan.issue_date,
                dueDate: loan.due_date,
                daysRemaining: diffDays,
                status: status,
                currentFine: fine
            };
        });

        res.json({
            success: true,
            issuedCount: loans.length,
            overdueCount: overdueCount,
            totalFine: totalFine,
            issuedBooks: enrichedLoans
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ success: false, message: 'Database error', error: err.message });
    }
});

// -------------------------------------------------------------
// 4. Search Books Catalog
// -------------------------------------------------------------
app.get('/api/books/search', async (req, res) => {
    const { query = '', category = '', semester = '' } = req.query;

    try {
        let sql = 'SELECT book_id, title, author, isbn, publisher, publication_year, category, semester, total_copies, available_copies, price, description FROM books WHERE 1=1';
        const params = [];

        if (query.trim()) {
            sql += ' AND (title LIKE ? OR author LIKE ? OR isbn LIKE ?)';
            const q = `%${query.trim()}%`;
            params.push(q, q, q);
        }
        if (category.trim()) {
            sql += ' AND category = ?';
            params.push(category.trim());
        }
        if (semester) {
            sql += ' AND semester = ?';
            params.push(parseInt(semester, 10));
        }

        sql += ' ORDER BY title ASC LIMIT 100';

        const [books] = await pool.query(sql, params);
        res.json({ success: true, count: books.length, books });
    } catch (err) {
        console.error('Book search error:', err);
        res.status(500).json({ success: false, message: 'Database error', error: err.message });
    }
});

// -------------------------------------------------------------
// 5. Reserve Book (When 0 copies available)
// -------------------------------------------------------------
app.post('/api/books/reserve', async (req, res) => {
    const { memberId, bookId } = req.body;
    if (!memberId || !bookId) {
        return res.status(400).json({ success: false, message: 'memberId and bookId are required' });
    }

    try {
        const [books] = await pool.query('SELECT available_copies, title FROM books WHERE book_id = ?', [bookId]);
        if (books.length === 0) {
            return res.status(404).json({ success: false, message: 'Book not found' });
        }

        if (books[0].available_copies > 0) {
            return res.status(400).json({
                success: false,
                message: `Book "${books[0].title}" currently has ${books[0].available_copies} copies available at the library counter! No reservation needed.`
            });
        }

        // Check if already reserved
        const [existing] = await pool.query(
            "SELECT reservation_id FROM reservations WHERE member_id = ? AND book_id = ? AND status = 'PENDING'",
            [memberId, bookId]
        );
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'You have already reserved this book.' });
        }

        await pool.query(
            "INSERT INTO reservations (member_id, book_id, reservation_date, status) VALUES (?, ?, CURDATE(), 'PENDING')",
            [memberId, bookId]
        );

        res.json({
            success: true,
            message: `Book "${books[0].title}" reserved successfully! You will be notified when it is returned.`
        });
    } catch (err) {
        console.error('Reservation error:', err);
        res.status(500).json({ success: false, message: 'Database error', error: err.message });
    }
});

// -------------------------------------------------------------
// 6. Student History (Past returned books & fines)
// -------------------------------------------------------------
app.get('/api/student/history', async (req, res) => {
    const memberId = req.query.memberId;
    if (!memberId) {
        return res.status(400).json({ success: false, message: 'memberId is required' });
    }

    try {
        const [history] = await pool.query(`
            SELECT t.transaction_id, t.issue_date, t.due_date, t.return_date, t.fine, t.status,
                   b.title, b.author, b.isbn
            FROM transactions t
            JOIN books b ON t.book_id = b.book_id
            WHERE t.member_id = ? AND t.status = 'RETURNED'
            ORDER BY t.return_date DESC
            LIMIT 50
        `, [memberId]);

        res.json({ success: true, count: history.length, history });
    } catch (err) {
        console.error('History error:', err);
        res.status(500).json({ success: false, message: 'Database error', error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] College Library Student API listening on http://0.0.0.0:${PORT}`);
});
