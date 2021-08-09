import React, { CSSProperties } from "react";

class Blank extends React.Component {
  render() {
    console.log("Blank!")

    return (
      <div style={styles.root}>
        <h1>Please log in to use this service.</h1>
        <div/>
        <h2>This page intentionally left blank.</h2>
      </div>
    );
  }
}

// https://stackoverflow.com/a/63086155
export interface StylesDictionary{
  [Key: string]: CSSProperties;
}

// https://stackoverflow.com/a/63086155
const styles: StylesDictionary = {
  root: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-around",
    alignItems: "center",
    flexShrink: 1
  }
}

export default Blank;
