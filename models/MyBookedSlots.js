/**
 * MyBookedSlots Model
 * Represents the current user's booked appointment slots
 */
class MyBookedSlots {
    constructor(json) {
        this.bookingDate = json.bookingDate && json.bookingDate.iso ? new Date(json.bookingDate.iso) : (json.bookingDate ? new Date(json.bookingDate) : null);
        this.doctorUid = json.doctorUid;
        this.hospitalUid = json.hospitalUid;
        this.slot = json.slot;
    }
}

export default MyBookedSlots;
