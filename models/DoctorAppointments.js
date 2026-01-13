/**
 * DoctorAppointments Model
 * Represents a doctor's appointment availability configuration
 */
class DoctorAppointments {
    constructor(json) {
        this.timeSlots = json.timeSlots;
        this.startDate = json.startDate && json.startDate.iso ? new Date(json.startDate.iso) : (json.startDate ? new Date(json.startDate) : null);
        this.doctorUid = json.doctorUid;
        this.hospitalUid = json.hospitalUid;
        this.day = json.day;
        this.sessionDuration = json.sessionDuration;
        this.every = json.every;
        this.objectId = json.objectId;
        this.price = json.price;
        this.currency = json.currency;
        this.isOnline = json.isOnline;
    }
}

export default DoctorAppointments;
