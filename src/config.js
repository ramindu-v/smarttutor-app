// Shared constants for the tuition centre.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Each class runs for two hours. Weekday classes start after school;
// weekends run all day with a lunch break at 12:00.
const DAY_HOURS = {
  0: [14, 16, 18], 1: [14, 16, 18], 2: [14, 16, 18], 3: [14, 16, 18], 4: [14, 16, 18],
  5: [8, 10, 12, 14, 16], 6: [8, 10, 12, 14, 16],
};
const LUNCH_HOUR = 12;

const GRADES = [6, 7, 8, 9, 10, 11, 12, 13];
const OL_SUBJECTS = ['Mathematics', 'Science', 'English', 'ICT'];
const AL_SUBJECTS = ['Combined Maths', 'Physics', 'Chemistry', 'Biology', 'ICT'];
const SUBJECTS = [...new Set([...OL_SUBJECTS, ...AL_SUBJECTS])];
const LAB_SUBJECTS = ['Physics', 'Chemistry', 'Biology'];

const subjectsForGrade = (grade) => (grade >= 12 ? AL_SUBJECTS : OL_SUBJECTS);

function slots() {
  const out = [];
  for (let day = 0; day < 7; day++) DAY_HOURS[day].forEach((hour, index) => out.push({ day, hour, index }));
  return out;
}

const ROLES = ['admin', 'coordinator', 'teacher', 'student'];

module.exports = { DAYS, DAY_HOURS, LUNCH_HOUR, GRADES, OL_SUBJECTS, AL_SUBJECTS, SUBJECTS, LAB_SUBJECTS, subjectsForGrade, slots, ROLES };
