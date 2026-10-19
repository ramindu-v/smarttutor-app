# What changed from the course submission

The original submission was five static HTML pages (login, dashboard, schedule, students, attendance). All of their data was typed into the HTML. This version turns that prototype into a working application and keeps the same look.

## Errors fixed

| Original problem | Now |
|---|---|
| `teachers.html` and `payments.html` were linked but did not exist (404). | Both pages are built. Reports, Notifications, My account and printable receipts were added too. |
| Teachers, Payments and Logout did nothing on most pages. | One shared sidebar, built per role, is used on every page. |
| Any username and password logged in. The role picker only changed the URL. | Real accounts with hashed passwords, sessions, and server-side role checks. |
| "Generate Schedule with AI" showed a spinner and a popup, and the timetable never changed. | A Prolog constraint solver builds the timetable. You preview it, then publish it. |
| Add Student, search, filters, pagination, view, edit and delete did nothing. | All of them work against the database. |
| Save Attendance, Mark All Present, Reset and the class picker did nothing. The page said 25 students but listed 5. | All of them work, with the real class list for each session. |
| The "ML predictions" were fixed sentences. | A trained model produces them, and its accuracy is reported. |
| `alert()` popups were used for every action. | In-page messages and confirmation dialogs. |
| Revenue was shown in ₹ (Indian rupees). | Shown in Rs (Sri Lankan rupees). |
| Pages broke on phones because the sidebar was a fixed 250px. | Responsive layout with a slide-in menu. |
| Only Grades 10 to 13, and no ICT in the student form, although the proposal says Grades 6 to 13 with Maths, Science, English and ICT. | Grades 6 to 13, with the O/L and A/L subjects. |
| "Mrs. Jay" and "Mrs. Jayasinghe" were the same teacher. | Consistent data. |
| Chart.js was loaded without a version number. | All libraries are pinned and served locally. |
| The same CSS and sidebar were copied into every page. | Shared `css/app.css` and `js/app.js`. |

## Added from the proposal

Node.js/Express backend, SQLite database, Prolog scheduling with conflict detection and minimal-disruption rescheduling, ML attendance prediction and at-risk alerts, ML batch recommendations, teacher availability, payments with receipts and reminders, notifications, reports, the four role portals, automated tests and documentation.
