import DoctorAppointments from './DoctorAppointments.js';
import BookedSlots from './BookedSlots.js';
import MyBookedSlots from './MyBookedSlots.js';

/**
 * AppointmentModel
 * Aggregates doctor appointments, booked slots, and user's booked slots
 */
class AppointmentModel {
    constructor(doctorAppointments, bookedSlots, myBookedSlots) {
        this.doctorAppointments = doctorAppointments;
        this.bookedSlots = bookedSlots;
        this.myBookedSlots = myBookedSlots;
    }

    static fromLogicResult(resultArray) {
        const getList = (arr, key) => {
            if (!Array.isArray(arr)) return [];
            // Parse Cloud returns array of objects like { "DoctorAppointments": [...] }
            // The key here must match the Cloud Function's return EXACTLY.
            // Based on logs, the Cloud Function seems to be returning Capitalized keys or the user's manual logic is.
            // Let's check both or fix to match log: [{"DoctorAppointments":...}]

            const item = arr.find(x => x[key]);
            return item ? item[key] : [];
        };
        // Fix: Use correct keys matching the JSON shown in logs
        const da = getList(resultArray, 'DoctorAppointments') || getList(resultArray, 'doctorAppointments');
        const bs = getList(resultArray, 'BookedSlots') || getList(resultArray, 'bookedSlots');
        const mbs = getList(resultArray, 'MyBookedSlots') || getList(resultArray, 'myBookedSlots');

        return new AppointmentModel(
            (da || []).map(x => new DoctorAppointments(x)),
            (bs || []).map(x => new BookedSlots(x)),
            (mbs || []).map(x => new MyBookedSlots(x))
        );
    }
}

export default AppointmentModel;
